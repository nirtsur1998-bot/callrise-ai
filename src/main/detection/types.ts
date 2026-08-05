/**
 * Shared types for ambient call detection (M15).
 *
 * Kept platform-agnostic on purpose: adapters (macOS/Windows/Null) all produce
 * `DetectionSignal`s in this shape, and everything downstream (fusion, the FSM,
 * policy) is pure and testable without touching any OS API.
 */

export type DetectionSignalKind =
  | 'own-virtual-device' // a foreign process opened OUR virtual mic -> strongest
  | 'mic-session' // a foreign process holds an active capture session
  | 'process' // a known conferencing binary is running
  | 'window-title' // window/tab title matches a call pattern
  | 'output-activity' // sustained render audio from a conferencing process
  | 'calendar' // a calendar event is live right now

/**
 * One observation from an adapter. `weight` is assigned by fusion.ts, never by
 * the adapter itself - adapters only report what they observed.
 */
export interface DetectionSignal {
  kind: DetectionSignalKind
  pid?: number
  appId: string // normalized: 'zoom' | 'teams' | 'meet' | 'slack' | 'webex' | 'unknown:<exe>'
  displayName: string // 'Zoom', 'Microsoft Teams'
  title?: string // window / tab title when available
  observedAt: number // epoch ms
  weight: number // set by fusion.ts, not by the adapter
}

export interface DetectedCall {
  id: string // stable while the call lives
  appId: string
  displayName: string
  pid?: number
  title?: string
  confidence: number // 0..1
  signals: DetectionSignalKind[]
  startedAt: number
  calendarEventId?: string
  calendarTitle?: string
  attendees?: string[]
}

export type DetectorState =
  | { name: 'idle' }
  | { name: 'candidate'; call: DetectedCall; since: number }
  | { name: 'detected'; call: DetectedCall } // awaiting policy decision / user answer
  | { name: 'capturing'; call: DetectedCall; sessionId: string }
  | { name: 'capturing-with-pending'; call: DetectedCall; sessionId: string; pending: DetectedCall }
  | { name: 'ending'; call: DetectedCall; since: number }

export type CaptureEndReason = 'call-ended' | 'user-stopped' | 'switched' | 'error'

/** Events the state machine / detector emit as it transitions. Consumed by CallDetector's IPC layer in a later phase. */
export type DetectorEvent =
  | { type: 'call-detected'; call: DetectedCall }
  | { type: 'switch-offered'; current: DetectedCall; pending: DetectedCall }
  | { type: 'switch-resolved'; decision: 'switched' | 'kept-current' | 'timed-out' }
  | { type: 'capture-started'; sessionId: string; call: DetectedCall; mode: 'full' | 'mic-only' }
  | { type: 'capture-ended'; sessionId: string; call: DetectedCall; reason: CaptureEndReason }
  | { type: 'call-lost'; call: DetectedCall } // detected/candidate disappeared before capture started

/**
 * Every tunable number in the detector lives here, referenced from exactly one
 * place, so tuning is a one-file change and every constant is independently
 * unit-testable.
 */
export const DETECTION_TUNING = {
  /** Rolling window (ms) over which raw signals are fused into a confidence score. */
  signalWindowMs: 10_000,

  /** Confidence must be >= this to leave idle and start counting toward detection. */
  startThreshold: 0.6,
  /** How long (ms) confidence must stay >= startThreshold before we call it "detected". */
  startSustainMs: 3_000,

  /** Confidence must drop below this to start counting toward call-end. */
  endThreshold: 0.35,
  /** How long (ms) confidence must stay < endThreshold before we call the capture ended. */
  endSustainMs: 15_000,

  /**
   * After a call (identified by appId+pid) ends, block it from re-triggering
   * detection for this long (ms) - a device switch or a Zoom breakout-room
   * bounce shouldn't look like two calls back to back.
   */
  hysteresisMs: 20_000,

  /** How long (ms) the switch-capture prompt stays up before defaulting to "keep current". */
  switchPromptTimeoutMs: 30_000,

  /** After the rep switches AWAY from a call, don't offer to switch BACK to
   *  it for this long (ms) — longer than the general `hysteresisMs` re-detect
   *  window on purpose: re-surfacing "switch back to the call you just left"
   *  is a more specific, more jarring interruption than the generic "don't
   *  instantly re-flag a just-stopped app as a brand new candidate" case
   *  hysteresisMs exists for, so it gets more breathing room. (M23: found
   *  declared but never wired into stateMachine.ts, which used only the
   *  generic 20s hysteresisMs for this — fixed.) */
  switchBackSuppressMs: 60_000,

  /** Calendar event counts as "live" starting this many ms before its start time. */
  calendarPreStartMs: 3 * 60 * 1000,
  /** Calendar event counts as "live" until this many ms after its end time. */
  calendarPostEndMs: 5 * 60 * 1000,

  /** Detection toast (ask policy) auto-dismisses as "Not now" after this long (ms). */
  detectionToastTimeoutMs: 20_000,

  /** Banner collapses to a slim pill after this long (ms) of no interaction. */
  bannerCollapseIdleMs: 6_000,
  /** Banner must appear within this long (ms) of entering the capturing state. */
  bannerAppearBudgetMs: 300,

  /** Adapter poll interval (ms) while idle - no candidate in sight. */
  pollIdleMs: 2_000,
  /** Adapter poll interval (ms) while a candidate is being evaluated - tighter loop until sustain resolves. */
  pollCandidateMs: 1_000,

  /**
   * Per-signal-kind confidence weight, keyed by DetectionSignalKind (+ a
   * known/unknown split for mic-session AND window-title — see fusion.ts's
   * weightForSignal). An "unknown" app is anything not in appRegistry's
   * CONFERENCING_APPS — detection must still work for it (no registry entry
   * required to ever reach 'capturing'), just at reduced confidence per
   * signal than a recognized app gets. mic-session-unknown was raised from
   * 0.25 to 0.35 specifically so that an unrecognized app with an active mic
   * session PLUS one weak corroborating signal (process, or a generic
   * call-sounding window title) can cross startThreshold - previously it
   * structurally could not (0.25 + process 0.1 + window-title 0.2 = 0.55,
   * always short of 0.6), which meant unlisted apps were undetectable no
   * matter what signals fired. Deliberately still short of mic-session-known
   * (0.55) and still can't cross the threshold alone (0.35 < 0.6) — an
   * unknown app needs real corroboration, not just any mic activity.
   */
  weights: {
    'own-virtual-device': 0.7,
    'mic-session-known': 0.55,
    'mic-session-unknown': 0.35,
    process: 0.1,
    'window-title-known': 0.2,
    'window-title-generic': 0.15,
    'output-activity': 0.15,
    calendar: 0.15
  }
} as const

export type DetectionTuning = typeof DETECTION_TUNING
