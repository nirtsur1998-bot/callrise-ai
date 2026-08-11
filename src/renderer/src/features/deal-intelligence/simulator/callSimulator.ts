// Call Simulator (M24 — testing requirements) — runs the Live Call State
// engine against a canned LiveTurn[] transcript instead of a real call, so
// the whole Tier 0 stack (and everything built on top of it in later
// phases) can be exercised deterministically with zero live audio/ASR.
//
// Two entry points because the two use cases want opposite timing:
//   - replaySync: unit tests want the end state NOW, synchronously, with no
//     wall-clock dependency — a test that took as long as the call it
//     simulates would be unusable.
//   - runSimulation: a human watching a CLI or dev UI wants the call to
//     actually FEEL like a call (turns arriving spaced out, signals firing
//     as they would live), just sped up. That needs real timers.
// Both fold the identical transcript through a fresh LiveCallStateEngine
// with identical config, so replaySync's result is exactly what
// runSimulation converges to (mid-run callbacks aside) — one is not a
// simplified stand-in for the other.
//
// Relative imports only (never '@renderer/...') — this file, like the
// engine and types it wraps, needs to run under plain tsx from
// scripts/run-call-simulator.ts without vite's alias resolution available.

import type { DealIntelligenceConfig, LiveCallState, LiveTurn, Tier0Signal } from '../types'
import { LiveCallStateEngine } from '../engine'

export interface ReplayResult {
  state: LiveCallState
  allSignals: Tier0Signal[]
}

/**
 * Synchronously folds every turn in `transcript` through a fresh engine.
 * No timers, no delay — the engine is a pure reducer so replaying instantly
 * produces the exact same state a paced real-time run converges to.
 *
 * Seeds callStartedAtMs from the transcript's own first turn (falling back
 * to 0 for an empty transcript) rather than Date.now(), so this stays
 * deterministic across runs and machines — a fixture recorded once replays
 * identically forever.
 */
export function replaySync(transcript: LiveTurn[], config?: DealIntelligenceConfig): ReplayResult {
  const callStartedAtMs = transcript[0]?.atMs ?? 0
  const engine = new LiveCallStateEngine(callStartedAtMs, config ?? {})
  const allSignals: Tier0Signal[] = []

  for (const turn of transcript) {
    allSignals.push(...engine.ingest(turn))
  }

  return { state: engine.state, allSignals }
}

export interface RunSimulationOptions {
  /** How much faster than real time to play the transcript. 5 = 5x speed.
   *  Defaults to 1 (real time). */
  speedMultiplier?: number
  onTurn?: (turn: LiveTurn, state: LiveCallState) => void
  onSignal?: (signal: Tier0Signal) => void
}

/**
 * Replays `transcript` paced in real (wall-clock) time, so a human watching
 * a live UI/CLI can feel the call happen rather than seeing the end state
 * appear instantly. Dev harness only — deliberately uses real Date.now()/
 * setTimeout rather than an injectable clock, since (unlike the engine
 * itself) this file's whole job is to be a faithful stand-in for wall-clock
 * time, not to be unit-testable.
 *
 * Every turn is scheduled relative to a single shared start time (not
 * chained delay-after-delay off the previous turn's timeout), so a slow
 * event loop tick doesn't compound drift across a long transcript — turn N
 * always lands at the same offset from t0 regardless of how turn N-1's
 * timer actually fired.
 */
export function runSimulation(
  transcript: LiveTurn[],
  opts: RunSimulationOptions = {}
): Promise<ReplayResult> {
  const { speedMultiplier = 1, onTurn, onSignal } = opts
  const callStartedAtMs = transcript[0]?.atMs ?? 0
  const engine = new LiveCallStateEngine(callStartedAtMs)
  const allSignals: Tier0Signal[] = []

  if (transcript.length === 0) {
    return Promise.resolve({ state: engine.state, allSignals })
  }

  return new Promise((resolve) => {
    const t0 = Date.now()
    let remaining = transcript.length

    transcript.forEach((turn) => {
      const delayMs = Math.max(0, (turn.atMs - callStartedAtMs) / speedMultiplier)
      const targetMs = t0 + delayMs

      setTimeout(
        () => {
          const signals = engine.ingest(turn)
          allSignals.push(...signals)
          onTurn?.(turn, engine.state)
          for (const signal of signals) onSignal?.(signal)

          remaining -= 1
          if (remaining === 0) resolve({ state: engine.state, allSignals })
        },
        Math.max(0, targetMs - Date.now())
      )
    })
  })
}
