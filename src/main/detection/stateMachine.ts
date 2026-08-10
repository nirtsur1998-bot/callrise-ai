import { groupKeyFor, type FusedCandidate } from './fusion'
import {
  DETECTION_TUNING,
  type DetectedCall,
  type DetectorEvent,
  type DetectorState,
  type DetectionTuning
} from './types'

/**
 * Bookkeeping that rides alongside the public `DetectorState` but never
 * crosses IPC: sustain timers for a secondary "other call" while the primary
 * one is being captured, hysteresis history, and the active session id
 * (dropped from the public `ending` state on purpose - it's transport-layer
 * detail the renderer doesn't need).
 */
export interface FsmContext {
  state: DetectorState
  /** `reason` picks which tuning window guards re-detection: 'switched-away'
   *  (the rep left this call for another one) uses the longer
   *  `switchBackSuppressMs`; 'ended' (a real hangup, decline, or error) uses
   *  the shorter general `hysteresisMs`. Both share one list because both are
   *  "don't re-surface this app+pid yet" facts checked the same way — only
   *  the window differs. */
  recentlyEnded: Array<{
    appId: string
    pid?: number
    endedAt: number
    reason: 'switched-away' | 'ended'
  }>
  otherCandidate?: { call: DetectedCall; since: number }
  activeSessionId?: string
  pendingOfferedAt?: number
}

export const initialFsmContext: FsmContext = { state: { name: 'idle' }, recentlyEnded: [] }

export type FsmCommand =
  // callId ties this ack to the specific call it was decided for - a late ack
  // that arrives after that call was lost/replaced (e.g. a slow OS mic-permission
  // prompt outlasting the call's own signals) must never be misapplied to
  // whatever different call now occupies 'detected'.
  | { type: 'start-capture'; callId: string; sessionId: string; mode: 'full' | 'mic-only' }
  | { type: 'decline-detection' }
  | { type: 'respond-to-switch'; decision: 'switch' | 'keep' }
  | { type: 'stop' }
  | { type: 'error' }

export interface StepInput {
  now: number
  /** Fused candidates for this tick - the output of fusion.fuseSignals(). */
  candidates: FusedCandidate[]
  command?: FsmCommand
}

export interface StepResult {
  context: FsmContext
  events: DetectorEvent[]
}

function callKey(call: DetectedCall): string {
  return groupKeyFor(call.appId, call.pid)
}

function findMatch(candidates: FusedCandidate[], call: DetectedCall): FusedCandidate | undefined {
  const key = callKey(call)
  return candidates.find((c) => c.key === key)
}

/** Each entry's own window — 'switched-away' gets the longer, more specific
 *  switch-back suppression; every other reason gets the general hysteresis. */
function windowFor(
  reason: FsmContext['recentlyEnded'][number]['reason'],
  tuning: DetectionTuning
): number {
  return reason === 'switched-away' ? tuning.switchBackSuppressMs : tuning.hysteresisMs
}

function isBlockedByHysteresis(
  candidate: FusedCandidate,
  recentlyEnded: FsmContext['recentlyEnded'],
  now: number,
  tuning: DetectionTuning
): boolean {
  return recentlyEnded.some(
    (e) =>
      now - e.endedAt < windowFor(e.reason, tuning) &&
      e.appId === candidate.appId &&
      (e.pid ?? null) === (candidate.pid ?? null)
  )
}

function pruneRecentlyEnded(
  recentlyEnded: FsmContext['recentlyEnded'],
  now: number,
  tuning: DetectionTuning
): FsmContext['recentlyEnded'] {
  return recentlyEnded.filter((e) => now - e.endedAt < windowFor(e.reason, tuning))
}

let callCounter = 0
function makeCallId(candidate: FusedCandidate, now: number): string {
  callCounter += 1
  return `call:${candidate.key}:${now}:${callCounter}`
}

function candidateToNewCall(candidate: FusedCandidate, now: number): DetectedCall {
  return {
    id: makeCallId(candidate, now),
    appId: candidate.appId,
    displayName: candidate.displayName,
    pid: candidate.pid,
    title: candidate.title,
    confidence: candidate.confidence,
    signals: candidate.signals,
    startedAt: now
  }
}

function mergeCandidateIntoCall(
  call: DetectedCall,
  candidate: FusedCandidate | undefined
): DetectedCall {
  if (!candidate) return call
  return {
    ...call,
    displayName: candidate.displayName,
    title: candidate.title ?? call.title,
    confidence: candidate.confidence,
    signals: candidate.signals
  }
}

function endCapture(
  context: FsmContext,
  reason: 'call-ended' | 'user-stopped' | 'error',
  call: DetectedCall,
  now: number,
  tuning: DetectionTuning
): StepResult {
  const sessionId = context.activeSessionId ?? 'unknown-session'
  return {
    context: {
      state: { name: 'idle' },
      recentlyEnded: pruneRecentlyEnded(
        [...context.recentlyEnded, { appId: call.appId, pid: call.pid, endedAt: now, reason: 'ended' }],
        now,
        tuning
      )
    },
    events: [{ type: 'capture-ended', sessionId, call, reason }]
  }
}

/**
 * Advance the FSM by one tick. Pure: no I/O, no timers, no randomness beyond
 * a monotonic in-process counter for call ids. Callers (CallDetector) supply
 * `now` and the freshly-fused candidates, and apply any pending `command`
 * (e.g. a policy decision, or a user's response to a prompt) that arrived
 * since the last tick.
 */
export function step(
  context: FsmContext,
  input: StepInput,
  tuning: DetectionTuning = DETECTION_TUNING
): StepResult {
  const { now, candidates, command } = input
  const recentlyEnded = pruneRecentlyEnded(context.recentlyEnded, now, tuning)
  const state = context.state

  switch (state.name) {
    case 'idle': {
      const top = candidates.find(
        (c) =>
          c.confidence >= tuning.startThreshold &&
          !isBlockedByHysteresis(c, recentlyEnded, now, tuning)
      )
      if (!top) {
        return { context: { ...context, recentlyEnded }, events: [] }
      }
      const call = candidateToNewCall(top, now)
      return {
        context: { ...context, state: { name: 'candidate', call, since: now }, recentlyEnded },
        events: []
      }
    }

    case 'candidate': {
      const match = findMatch(candidates, state.call)
      if (!match || match.confidence < tuning.startThreshold) {
        // Never crossed the sustain window into a real detection - nothing to report.
        return { context: { ...context, state: { name: 'idle' }, recentlyEnded }, events: [] }
      }
      const updated = mergeCandidateIntoCall(state.call, match)
      if (now - state.since >= tuning.startSustainMs) {
        return {
          context: { ...context, state: { name: 'detected', call: updated }, recentlyEnded },
          events: [{ type: 'call-detected', call: updated }]
        }
      }
      return {
        context: {
          ...context,
          state: { name: 'candidate', call: updated, since: state.since },
          recentlyEnded
        },
        events: []
      }
    }

    case 'detected': {
      if (command?.type === 'start-capture' && command.callId === state.call.id) {
        return {
          context: {
            ...context,
            state: { name: 'capturing', call: state.call, sessionId: command.sessionId },
            activeSessionId: command.sessionId,
            recentlyEnded
          },
          events: [
            {
              type: 'capture-started',
              sessionId: command.sessionId,
              call: state.call,
              mode: command.mode
            }
          ]
        }
      }
      if (command?.type === 'decline-detection' || command?.type === 'error') {
        // 'error' arrives here when the renderer's ambient auto-start actually
        // failed (mic denied, no device, transcription.start rejected - see
        // detection-service.ts's captureFailed handler) - WHILE still in
        // 'detected', since start-capture was never applied. Treat it exactly
        // like a decline: back to idle, with hysteresis, so the FSM doesn't
        // stay parked here forever (a single global state means no other call
        // could ever be noticed while stuck).
        return {
          context: {
            ...context,
            state: { name: 'idle' },
            recentlyEnded: pruneRecentlyEnded(
              [
                ...recentlyEnded,
                { appId: state.call.appId, pid: state.call.pid, endedAt: now, reason: 'ended' }
              ],
              now,
              tuning
            )
          },
          events: []
        }
      }
      const match = findMatch(candidates, state.call)
      if (!match || match.confidence < tuning.endThreshold) {
        return {
          context: { ...context, state: { name: 'idle' }, recentlyEnded },
          events: [{ type: 'call-lost', call: state.call }]
        }
      }
      return {
        context: {
          ...context,
          state: { name: 'detected', call: mergeCandidateIntoCall(state.call, match) },
          recentlyEnded
        },
        events: []
      }
    }

    case 'capturing': {
      if (command?.type === 'stop')
        return endCapture(context, 'user-stopped', state.call, now, tuning)
      if (command?.type === 'error') return endCapture(context, 'error', state.call, now, tuning)

      const match = findMatch(candidates, state.call)
      const confidence = match?.confidence ?? 0

      if (confidence < tuning.endThreshold) {
        // Clear any in-progress switch candidate: its `since` is a sustain timer
        // for the OTHER call, not this one - left untouched across an ending
        // detour, it would credit however long the detour lasted (up to just
        // under endSustainMs) toward that timer, so a switch-offer could fire
        // the instant this call recovers, from wall-clock time that elapsed
        // during an unrelated dip rather than genuine continuous re-sustain.
        return {
          context: {
            ...context,
            state: { name: 'ending', call: mergeCandidateIntoCall(state.call, match), since: now },
            otherCandidate: undefined,
            recentlyEnded
          },
          events: []
        }
      }

      const currentCall = mergeCandidateIntoCall(state.call, match)
      const others = candidates.filter(
        (c) =>
          c.key !== callKey(state.call) && !isBlockedByHysteresis(c, recentlyEnded, now, tuning)
      )
      const topOther = others.find((c) => c.confidence >= tuning.startThreshold)

      if (!topOther) {
        return {
          context: {
            ...context,
            state: { ...state, call: currentCall },
            otherCandidate: undefined,
            recentlyEnded
          },
          events: []
        }
      }

      const existingOther = context.otherCandidate
      if (existingOther && callKey(existingOther.call) === topOther.key) {
        const updatedOther = mergeCandidateIntoCall(existingOther.call, topOther)
        if (now - existingOther.since >= tuning.startSustainMs) {
          return {
            context: {
              ...context,
              state: {
                name: 'capturing-with-pending',
                call: currentCall,
                sessionId: state.sessionId,
                pending: updatedOther
              },
              otherCandidate: undefined,
              pendingOfferedAt: now,
              recentlyEnded
            },
            events: [{ type: 'switch-offered', current: currentCall, pending: updatedOther }]
          }
        }
        return {
          context: {
            ...context,
            state: { ...state, call: currentCall },
            otherCandidate: { call: updatedOther, since: existingOther.since },
            recentlyEnded
          },
          events: []
        }
      }

      return {
        context: {
          ...context,
          state: { ...state, call: currentCall },
          otherCandidate: { call: candidateToNewCall(topOther, now), since: now },
          recentlyEnded
        },
        events: []
      }
    }

    case 'capturing-with-pending': {
      if (command?.type === 'stop')
        return endCapture(context, 'user-stopped', state.call, now, tuning)
      if (command?.type === 'error') return endCapture(context, 'error', state.call, now, tuning)

      if (command?.type === 'respond-to-switch') {
        if (command.decision === 'switch') {
          return {
            context: {
              ...context,
              state: { name: 'detected', call: state.pending },
              activeSessionId: undefined,
              pendingOfferedAt: undefined,
              recentlyEnded: pruneRecentlyEnded(
                [
                  ...recentlyEnded,
                  { appId: state.call.appId, pid: state.call.pid, endedAt: now, reason: 'switched-away' }
                ],
                now,
                tuning
              )
            },
            events: [
              { type: 'switch-resolved', decision: 'switched' },
              {
                type: 'capture-ended',
                sessionId: state.sessionId,
                call: state.call,
                reason: 'switched'
              }
            ]
          }
        }
        return {
          context: {
            ...context,
            state: { name: 'capturing', call: state.call, sessionId: state.sessionId },
            pendingOfferedAt: undefined,
            recentlyEnded
          },
          events: [{ type: 'switch-resolved', decision: 'kept-current' }]
        }
      }

      const match = findMatch(candidates, state.call)
      const confidence = match?.confidence ?? 0

      // A confidence dip gets the SAME grace period plain 'capturing' gives it
      // (-> 'ending', recoverable within endSustainMs) rather than
      // unconditionally declaring the call over the instant a switch happens
      // to be pending - a one-tick mic-session/window-title blip on the
      // primary call shouldn't permanently end it and force a switch just
      // because a second app was also active. The pending switch offer is
      // dropped rather than preserved through the detour (simplest safe
      // choice - 'respond-to-switch' has no handler outside this state, and
      // silently letting a stale offer sit in the renderer would let a click
      // on it do nothing); if the other app is still around once the primary
      // recovers, plain 'capturing' will naturally re-offer a switch after a
      // fresh sustain window.
      if (confidence < tuning.endThreshold) {
        return {
          context: {
            ...context,
            state: { name: 'ending', call: mergeCandidateIntoCall(state.call, match), since: now },
            otherCandidate: undefined,
            pendingOfferedAt: undefined,
            recentlyEnded
          },
          events: [{ type: 'switch-resolved', decision: 'kept-current' }]
        }
      }

      if (
        context.pendingOfferedAt != null &&
        now - context.pendingOfferedAt >= tuning.switchPromptTimeoutMs
      ) {
        return {
          context: {
            ...context,
            state: {
              name: 'capturing',
              call: mergeCandidateIntoCall(state.call, match),
              sessionId: state.sessionId
            },
            pendingOfferedAt: undefined,
            recentlyEnded
          },
          events: [{ type: 'switch-resolved', decision: 'timed-out' }]
        }
      }

      return {
        context: {
          ...context,
          state: { ...state, call: mergeCandidateIntoCall(state.call, match) },
          recentlyEnded
        },
        events: []
      }
    }

    case 'ending': {
      if (command?.type === 'stop')
        return endCapture(context, 'user-stopped', state.call, now, tuning)
      if (command?.type === 'error') return endCapture(context, 'error', state.call, now, tuning)

      const match = findMatch(candidates, state.call)
      const confidence = match?.confidence ?? 0

      if (confidence >= tuning.endThreshold) {
        // Recovered within the grace window - e.g. a mute or a breakout-room move. Resume capturing.
        return {
          context: {
            ...context,
            state: {
              name: 'capturing',
              call: mergeCandidateIntoCall(state.call, match),
              sessionId: context.activeSessionId ?? 'unknown-session'
            },
            recentlyEnded
          },
          events: []
        }
      }

      if (now - state.since >= tuning.endSustainMs) {
        return endCapture(context, 'call-ended', state.call, now, tuning)
      }

      return {
        context: {
          ...context,
          state: { ...state, call: mergeCandidateIntoCall(state.call, match) },
          recentlyEnded
        },
        events: []
      }
    }

    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}
