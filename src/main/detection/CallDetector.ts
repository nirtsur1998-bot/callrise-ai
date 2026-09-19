import { isOwnProcess } from './appRegistry'
import { fuseSignals, groupKeyFor, type FusedCandidate } from './fusion'
import { initialFsmContext, step, type FsmCommand, type FsmContext } from './stateMachine'
import {
  DETECTION_TUNING,
  type DetectionSignal,
  type DetectorEvent,
  type DetectorState,
  type DetectionTuning
} from './types'
import type { ICallDetectorAdapter } from './adapters/ICallDetectorAdapter'

export interface CallDetectorOptions {
  adapter: ICallDetectorAdapter
  tuning?: DetectionTuning
  /** Injectable clock, for tests. Defaults to Date.now. */
  now?: () => number
  /** Our own process id, to exclude self-signals (the virtual mic + our own capture must never self-trigger). */
  ourPid?: number
  /**
   * BUG-007: an app the user set to 'never' in per-app capture policy must
   * never raise ANY prompt for it - not the initial detection ask (already
   * handled downstream by policy.decideCaptureAction), and not a mid-capture
   * switch offer either (that path never consulted policy at all; a 'never'
   * app could still interrupt an active capture asking to switch to it).
   * Read live (a function, not a snapshot) since the Settings screen can
   * change overrides while detection is running. Candidates for a blocked
   * app are dropped before the FSM ever sees them, so the fix is one seam
   * rather than duplicated inside every state that picks a candidate.
   *
   * NEVER applied to the call actively being captured (see `tick()`) - this
   * gates what gets OFFERED, not what the FSM is already recording. Filtering
   * the live call's own signal out mid-capture would read as the call ending
   * (confidence -> 0 -> `ending` -> `capture-ended` after endSustainMs), so a
   * Settings edit made mid-call would silently stop a real recording -
   * exactly the class of bug this project treats as worst-severity.
   */
  isAppBlocked?: (appId: string) => boolean
}

/**
 * Orchestrator: owns one adapter, buffers its raw signals, fuses them each
 * tick, and drives the pure FSM. This class is the only stateful/impure piece
 * of the detector - everything it delegates to (fusion, stateMachine) stays
 * pure and independently testable.
 *
 * No IPC here yet (that's Phase 4/5) - `onEvent`/`getState` are the seams a
 * later IPC layer will wire up.
 */
export class CallDetector {
  private readonly adapter: ICallDetectorAdapter
  private readonly tuning: DetectionTuning
  private readonly now: () => number
  private readonly ourPid?: number
  private readonly isAppBlocked?: (appId: string) => boolean

  private signalBuffer: DetectionSignal[] = []
  private fsmContext: FsmContext = initialFsmContext
  private pendingCommand?: FsmCommand
  private unsubscribe?: () => void
  private pollTimer?: ReturnType<typeof setTimeout>
  private eventListeners = new Set<(event: DetectorEvent) => void>()

  constructor(options: CallDetectorOptions) {
    this.adapter = options.adapter
    this.tuning = options.tuning ?? DETECTION_TUNING
    this.now = options.now ?? Date.now
    this.ourPid = options.ourPid
    this.isAppBlocked = options.isAppBlocked
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.adapter.onSignal((signal) => this.handleSignal(signal))
    this.adapter.start()
    this.schedulePoll()
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.adapter.stop()
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  getState(): DetectorState {
    return this.fsmContext.state
  }

  /** Debug-only: the current fused candidates + state, for the headless debug command. Not used by production logic. */
  getDebugSnapshot(now: number = this.now()): {
    state: DetectorState
    candidates: FusedCandidate[]
  } {
    const candidates = fuseSignals(
      this.signalBuffer.filter((s) => now - s.observedAt <= this.tuning.signalWindowMs),
      now,
      this.tuning
    )
    return { state: this.fsmContext.state, candidates }
  }

  onEvent(callback: (event: DetectorEvent) => void): () => void {
    this.eventListeners.add(callback)
    return () => this.eventListeners.delete(callback)
  }

  /** Queue a command (a policy decision, or a user's response) to be applied on the next tick, then tick immediately. */
  applyCommand(command: FsmCommand): void {
    this.pendingCommand = command
    this.tick()
  }

  private handleSignal(signal: DetectionSignal): void {
    if (isOwnProcess({ pid: signal.pid, ourPid: this.ourPid, processName: signal.displayName }))
      return
    this.signalBuffer.push(signal)
  }

  /** The call presently being recorded, if any - its own candidate must never
   *  be dropped by `isAppBlocked` (see the option's doc comment). */
  private activeCallKey(): string | undefined {
    const state = this.fsmContext.state
    if (state.name === 'capturing' || state.name === 'capturing-with-pending' || state.name === 'ending') {
      return groupKeyFor(state.call.appId, state.call.pid)
    }
    return undefined
  }

  /** Advance the detector by one tick. Exposed directly for tests to drive with an explicit `now`. */
  tick(now: number = this.now()): void {
    this.signalBuffer = this.signalBuffer.filter(
      (s) => now - s.observedAt <= this.tuning.signalWindowMs
    )
    const activeKey = this.activeCallKey()
    const candidates = fuseSignals(this.signalBuffer, now, this.tuning).filter(
      (c) => c.key === activeKey || !this.isAppBlocked?.(c.appId)
    )

    const command = this.pendingCommand
    this.pendingCommand = undefined

    const result = step(this.fsmContext, { now, candidates, command }, this.tuning)
    this.fsmContext = result.context
    for (const event of result.events) {
      for (const listener of this.eventListeners) listener(event)
    }
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    const interval =
      this.fsmContext.state.name === 'idle' ? this.tuning.pollIdleMs : this.tuning.pollCandidateMs
    this.pollTimer = setTimeout(() => {
      this.tick()
      this.schedulePoll() // self-reschedule at the (possibly new) interval for the post-tick state
    }, interval)
  }
}
