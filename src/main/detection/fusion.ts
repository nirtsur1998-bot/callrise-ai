import { isKnownConferencingApp } from './appRegistry'
import {
  DETECTION_TUNING,
  type DetectionSignal,
  type DetectionSignalKind,
  type DetectionTuning
} from './types'

/** A call candidate produced by fusing raw signals for one appId/pid group over the rolling window. */
export interface FusedCandidate {
  /** Group key: `pid:<pid>` when a pid is known, else `app:<appId>` (browser-hosted apps rarely expose a distinct pid per tab). */
  key: string
  appId: string
  pid?: number
  displayName: string
  title?: string
  confidence: number
  signals: DetectionSignalKind[]
  /** Most recent `observedAt` across the group's signals. */
  lastObservedAt: number
  /** Earliest `observedAt` across the group's signals still inside the window. */
  firstObservedAt: number
}

/** The weight a single raw signal contributes, before summation/capping. */
export function weightForSignal(
  signal: DetectionSignal,
  tuning: DetectionTuning = DETECTION_TUNING
): number {
  const w = tuning.weights
  switch (signal.kind) {
    case 'own-virtual-device':
      return w['own-virtual-device']
    case 'mic-session':
      return isKnownConferencingApp(signal.appId)
        ? w['mic-session-known']
        : w['mic-session-unknown']
    case 'process':
      return w.process
    case 'window-title':
      // Same known/unknown split as mic-session, and for the same reason: a
      // window-title signal for a registered app (an exact per-app pattern
      // match, e.g. /zoom meeting/i) is stronger evidence than one for an
      // unrecognized app (matched only by appRegistry's generic
      // looksLikeCallTitle() heuristic — see MacAdapter/WindowsAdapter).
      return isKnownConferencingApp(signal.appId)
        ? w['window-title-known']
        : w['window-title-generic']
    case 'output-activity':
      return w['output-activity']
    case 'calendar':
      return w.calendar
    default:
      return 0
  }
}

/** Group key for a raw signal or a DetectedCall - shared so the state machine can match a call back to its fused candidate. */
export function groupKeyFor(appId: string, pid?: number): string {
  return pid != null ? `pid:${pid}` : `app:${appId}`
}

function groupKey(signal: DetectionSignal): string {
  return groupKeyFor(signal.appId, signal.pid)
}

/**
 * Fuse raw signals observed within `tuning.signalWindowMs` of `now` into one
 * confidence score per appId/pid group. Confidence is additive across signal
 * *kinds* (a duplicate signal of the same kind doesn't stack - we take the
 * strongest instance of each kind), capped at 1.0.
 */
export function fuseSignals(
  signals: DetectionSignal[],
  now: number,
  tuning: DetectionTuning = DETECTION_TUNING
): FusedCandidate[] {
  const windowStart = now - tuning.signalWindowMs
  const inWindow = signals.filter((s) => s.observedAt >= windowStart && s.observedAt <= now)

  const groups = new Map<string, DetectionSignal[]>()
  for (const signal of inWindow) {
    const key = groupKey(signal)
    const list = groups.get(key)
    if (list) list.push(signal)
    else groups.set(key, [signal])
  }

  const candidates: FusedCandidate[] = []
  for (const [key, group] of groups) {
    const strongestByKind = new Map<DetectionSignalKind, DetectionSignal>()
    for (const signal of group) {
      const weight = weightForSignal(signal, tuning)
      const existing = strongestByKind.get(signal.kind)
      const existingWeight = existing ? weightForSignal(existing, tuning) : -1
      if (weight > existingWeight) strongestByKind.set(signal.kind, signal)
    }

    const contributing = [...strongestByKind.values()]
    const confidence = Math.min(
      1,
      contributing.reduce((sum, signal) => sum + weightForSignal(signal, tuning), 0)
    )

    const mostRecent = group.reduce((a, b) => (b.observedAt > a.observedAt ? b : a))
    const oldest = group.reduce((a, b) => (b.observedAt < a.observedAt ? b : a))
    const withTitle = [...group].reverse().find((s) => s.title)

    candidates.push({
      key,
      appId: mostRecent.appId,
      pid: mostRecent.pid,
      displayName: mostRecent.displayName,
      title: withTitle?.title,
      confidence,
      signals: contributing.map((s) => s.kind),
      lastObservedAt: mostRecent.observedAt,
      firstObservedAt: oldest.observedAt
    })
  }

  return candidates.sort((a, b) => b.confidence - a.confidence)
}
