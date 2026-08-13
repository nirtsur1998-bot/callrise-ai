// The M24 orchestration hook — wires Phase 1's LiveCallStateEngine, Tier 1
// micro-analysis, Tier 2 strategic analysis, context fusion, and the Nudge
// Engine into one thing a live-call screen can mount. Owns both cadences
// (§3: Tier 1 triggered by a Tier 0 event or every ~20s; §4: Tier 2 every
// ~2.5min or on a call-stage change) and hands cue quality-gating off to
// nudgeEngine.ts.
//
// Takes `segments` (useTranscription's own CallSegment[] return value) and
// `meeting` (LiveView's own currentMeeting) as plain props and watches them
// via effect, the same "sibling hook consuming already-computed state" shape
// useLiveCues already uses — rather than threading callbacks into
// useTranscription's or useCalendar's own internals. See the Phase 1
// codebase map's finding that CallSegment is the one stream that already has
// role attribution solved; nothing here re-derives that.
//
// "Abort any in-flight request the moment newer transcript supersedes it"
// (the milestone's own latency rule) is approximated, not literal: Electron
// IPC invoke doesn't carry an AbortSignal across the renderer/main boundary
// without extra plumbing this phase doesn't add, so a stale in-flight
// response is discarded client-side via a generation counter instead of
// truly cancelled server-side. The practical effect for the rep is the
// same — a stale answer never wins — the only difference is the wasted
// tokens/latency on a call whose answer gets thrown away, which is an
// acceptable cost for the simpler, more robust implementation.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallSegment } from '@renderer/features/calls/types'
import type { CalendarEvent } from '@renderer/features/calendar/types'
import type { DealHealthScorePoint, DealIntelligenceRecord } from '../../../../preload/index.d'
import { LiveCallStateEngine, type LiveTurn } from './engine'
import type { CallStage } from './types'
import {
  createNudgeEngineState,
  dismissNudge as dismissNudgeFromState,
  evaluateSignals,
  type FeedbackAdjustment,
  type Nudge,
  type NudgeEngineState,
  type Sensitivity
} from './nudgeEngine'
import { analyzeTier1 } from './tier1/analyze'
import { summarizeLiveCallState } from './summarize'
import { analyzeTier2 } from './tier2/analyze'
import { buildDealContext } from './contextFusion'
import { sanitizeHealthScoreResponse, type DealHealthScore } from './healthScore'
import {
  FREQUENCY_MULTIPLIER,
  type AnalysisFrequency,
  type EnabledNudgeTypes
} from './useDealIntelligenceSettings'

const EMPTY_REPORT: DealIntelligenceRecord = { nudges: [], healthScoreHistory: [] }

const TIER1_INTERVAL_MS = 20_000
/** Floor between the STARTS of two Tier 1 calls, independent of the Nudge
 *  Engine's own cooldown (which only limits how often a nudge is SHOWN) —
 *  this limits how often the AI is even asked, which matters for cost/rate
 *  limits even on a pass that ends up producing nothing. */
const MIN_GAP_BETWEEN_TIER1_CALLS_MS = 5_000
/** Safety cap on how many turns accumulate into one Tier 1 delta — mirrors
 *  the MAX_INPUT-style guards elsewhere in this codebase's live-AI call
 *  sites (e.g. live-cue.ts) against an unbounded prompt if analysis is
 *  somehow starved for a long stretch. */
const MAX_TIER1_DELTA_TURNS = 40

/** §4's own "every 2-3 minutes" — the midpoint. */
const TIER2_INTERVAL_MS = 150_000
/** Tier 2's own floor between call STARTS — longer than Tier 1's, since a
 *  stage-change trigger firing right after the routine interval already ran
 *  is the realistic collision case this guards against, not a burst. */
const MIN_GAP_BETWEEN_TIER2_CALLS_MS = 60_000
/** Tier 2 runs far less often than Tier 1, so its delta window covers much
 *  more real conversation — generously capped, still well short of "the
 *  whole transcript" per the milestone's token-discipline rule. */
const MAX_TIER2_DELTA_TURNS = 200
/** §8's Radar Report — a defensive client-side cap on how much health-score
 *  history accumulates during one call, independent of (but smaller than)
 *  main/calls-fs.ts's own save-time cap. */
const MAX_RADAR_REPORT_HEALTH_POINTS = 100

export type DealIntelligenceStatus = 'idle' | 'active' | 'paused'

export interface UseDealIntelligence {
  status: DealIntelligenceStatus
  nudges: Nudge[]
  dismissNudge: (id: string) => void
  healthScore: DealHealthScore | null
  /** M24 §8 — rate a nudge helpful/not. Fires immediately to the local
   *  feedback log (adapts future calls, not this one — see nudgeEngine.ts's
   *  FeedbackAdjustment doc comment) and is folded into this call's own
   *  Radar Report the next time getDealIntelligenceReport() is read. */
  rateNudge: (id: string, helpful: boolean) => void
  /** A function, not a value — same reason useTranscription.ts's
   *  getSessionId is a function: the caller (LiveView's handleSaved) needs
   *  whatever this call actually produced at the moment it asks, regardless
   *  of whether a re-render (or this hook's own per-call reset) happened
   *  since the last render. Safe to call at any time, including well after
   *  the call has ended. */
  getDealIntelligenceReport: () => DealIntelligenceRecord
}

export function useDealIntelligence(
  /** The same CallSegment[] LiveView already receives from useTranscription. */
  segments: CallSegment[],
  /** Mirrors how useLiveCues is invoked: `status === 'listening'`. */
  active: boolean,
  enabled: boolean,
  /** M26 4.5 (BUG-055) — the CALL id, from useTranscription's getCallId().
   *  Distinguishes "a genuinely new call started" from "this call's `active`
   *  merely blipped" (a mono<->multichannel restart, or — before this hook was
   *  hoisted above the navigation boundary — a screen remount). Only a change
   *  in THIS value, not in `active`, may trigger the per-call reset below. */
  getCallId: () => string | null,
  /** M26 4.5 (BUG-055) — from useTranscription's getSessionId(). Passed with
   *  every Tier 1/Tier 2 call so main can check FRESH consent (never a
   *  renderer-held snapshot) before any buyer-attributed turn in the batch
   *  reaches an AI prompt. */
  getSessionId: () => number | null,
  sensitivity: Sensitivity,
  agendaTopics: string[] = [],
  /** LiveView's own currentMeeting (§5 context fusion) — null when this call
   *  has no matching calendar event, a normal case (ambient/manual start),
   *  not an error. Read once at call start; a mid-call change to WHICH
   *  meeting this is would be unusual and isn't specially handled. */
  meeting: CalendarEvent | null = null,
  /** §10 settings polish — which of risk/opportunity/tactical to surface at
   *  all. Filtered out of Tier 1's candidates before they ever reach the
   *  Nudge Engine, not just hidden after the fact. */
  enabledTypes: EnabledNudgeTypes = { risk: true, opportunity: true, tactical: true },
  /** §10 settings polish — scales both cadences together; see
   *  FREQUENCY_MULTIPLIER's own doc comment for why not raw ms knobs. */
  frequency: AnalysisFrequency = 'balanced'
): UseDealIntelligence {
  const [nudges, setNudges] = useState<Nudge[]>([])
  const [status, setStatus] = useState<DealIntelligenceStatus>('idle')
  const [healthScore, setHealthScore] = useState<DealHealthScore | null>(null)

  // M26 4.5 (BUG-055) — see the reset effect below. Tracks what the LAST
  // reset decision was based on, so the effect can tell a genuine call
  // boundary apart from `active` merely blipping mid-call.
  const lastCallIdRef = useRef<string | null>(null)
  const wasEnabledRef = useRef(enabled)

  const engineRef = useRef<LiveCallStateEngine | null>(null)
  const nudgeStateRef = useRef<NudgeEngineState>(createNudgeEngineState())
  const processedCountRef = useRef(0)
  const callStartWallClockRef = useRef<number | null>(null)
  const pendingTier1TurnsRef = useRef<LiveTurn[]>([])
  const pendingTier2TurnsRef = useRef<LiveTurn[]>([])
  const lastRepTextRef = useRef<string | null>(null)
  const lastCallStageRef = useRef<CallStage | null>(null)
  const lastTier1StartedAtMsRef = useRef<number | null>(null)
  const lastTier2StartedAtMsRef = useRef<number | null>(null)
  const generationRef = useRef(0)
  const tier1InFlightRef = useRef(false)
  const tier2InFlightRef = useRef(false)
  const healthScoreRef = useRef<DealHealthScore | null>(null)
  const dealContextRef = useRef('')
  const healthScoreHistoryRef = useRef<DealHealthScorePoint[]>([])
  const feedbackAdjustmentsRef = useRef<FeedbackAdjustment[]>([])
  const nudgeFeedbackRef = useRef<Map<string, 'helpful' | 'not-helpful'>>(new Map())
  /** Snapshot taken the moment reset() runs — the fallback getDealIntelligenceReport()
   *  reads once the live refs below have already been cleared for the NEXT call. */
  const finalizedReportRef = useRef<DealIntelligenceRecord>(EMPTY_REPORT)

  const enabledTypesRef = useRef(enabledTypes)
  useEffect(() => {
    enabledTypesRef.current = enabledTypes
  }, [enabledTypes])

  const sensitivityRef = useRef(sensitivity)
  useEffect(() => {
    sensitivityRef.current = sensitivity
  }, [sensitivity])
  const agendaTopicsRef = useRef(agendaTopics)
  useEffect(() => {
    agendaTopicsRef.current = agendaTopics
  }, [agendaTopics])
  const meetingRef = useRef(meeting)
  useEffect(() => {
    meetingRef.current = meeting
  }, [meeting])

  /** Pure read of the current live refs into a DealIntelligenceRecord.
   *  Returns the literal EMPTY_REPORT reference (not just an equal-shaped
   *  object) when there's no live call to read — getDealIntelligenceReport()
   *  below uses that reference identity to know whether to fall back to the
   *  snapshot reset() took instead. */
  const computeReport = useCallback((): DealIntelligenceRecord => {
    const startedAt = callStartWallClockRef.current
    if (startedAt === null) return EMPTY_REPORT
    const nudgeRecords = nudgeStateRef.current.history.map((n) => ({
      id: n.id,
      type: n.type,
      subtype: n.subtype,
      confidence: n.confidence,
      evidenceQuote: n.evidenceQuote,
      evidenceRole: n.evidenceRole,
      suggestedCue: n.suggestedCue,
      atMs: Math.max(0, n.createdAtMs - startedAt),
      feedback: nudgeFeedbackRef.current.get(n.id)
    }))
    return { nudges: nudgeRecords, healthScoreHistory: healthScoreHistoryRef.current }
  }, [])

  const reset = useCallback(() => {
    // Snapshot THIS call's report before clearing anything below — the
    // ordering between useTranscription's `active` flipping false and its
    // async save-then-onSaved chain calling getDealIntelligenceReport() is
    // not guaranteed either way, so both paths need to produce the right
    // answer: computeReport() while still live, this snapshot once cleared.
    finalizedReportRef.current = computeReport()
    engineRef.current = null
    nudgeStateRef.current = createNudgeEngineState()
    processedCountRef.current = 0
    callStartWallClockRef.current = null
    pendingTier1TurnsRef.current = []
    pendingTier2TurnsRef.current = []
    lastRepTextRef.current = null
    lastCallStageRef.current = null
    lastTier1StartedAtMsRef.current = null
    lastTier2StartedAtMsRef.current = null
    generationRef.current++ // orphans any in-flight response from the ending call
    tier1InFlightRef.current = false
    tier2InFlightRef.current = false
    healthScoreRef.current = null
    dealContextRef.current = ''
    healthScoreHistoryRef.current = []
    feedbackAdjustmentsRef.current = []
    nudgeFeedbackRef.current = new Map()
    setNudges([])
    setHealthScore(null)
    setStatus('idle')
  }, [computeReport])

  // M26 4.5 (BUG-055) — `active` (`status === 'listening'`) is NOT a proxy for
  // "the call ended." It also goes false during a mono<->multichannel restart
  // mid-call (main emits `state:'connecting'` for that too — see
  // transcription.ts's transcription:start handler) — a real, ordinary event
  // that must not wipe this call's nudge history, health-score baseline, or
  // (before this hook was hoisted into LiveCallProvider) simply the screen
  // being navigated away from and back. Resetting on every such blip is what
  // let a fresh `LiveCallStateEngine` replay the ENTIRE transcript from
  // scratch on the next segment tick, re-deriving and re-firing signals that
  // had already fired once.
  //
  // The only two events that legitimately mean "start over": a genuinely NEW
  // call (a different callId than last observed — never fires on the FIRST
  // call, since there is nothing yet to reset), or the rep explicitly turning
  // the feature off (a true→false edge on `enabled`, not merely `enabled`
  // being false on the very first render).
  useEffect(() => {
    const currentCallId = getCallId()
    const isGenuineNewCall =
      currentCallId !== null &&
      lastCallIdRef.current !== null &&
      currentCallId !== lastCallIdRef.current
    const justDisabled = wasEnabledRef.current && !enabled
    lastCallIdRef.current = currentCallId
    wasEnabledRef.current = enabled

    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset per-call state on a genuine call boundary or the feature being toggled off, same pattern as CallDetail.tsx's per-call reset
    if (isGenuineNewCall || justDisabled) reset()
    // `active` is deliberately still a dependency — not because its VALUE is
    // trusted (that's the bug this fix removes), but because `getCallId()` is
    // a stable function reference by design (see useTranscription.ts's own
    // comment on why) and cannot itself trigger a re-run. `active` toggling is
    // what reliably brings this effect back to LOOK at the current callId at
    // both of the moments that matter (a call starting, a call ending) — it's
    // just no longer trusted to mean "start over" on its own.
  }, [active, enabled, getCallId, reset])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing status to the active+enabled transition, mirrors the reset effect above
    if (active && enabled) setStatus('active')
  }, [active, enabled])

  const runTier1Pass = useCallback(
    async (triggerReason: string) => {
      if (!enabled || tier1InFlightRef.current) return
      const now = Date.now()
      if (
        lastTier1StartedAtMsRef.current !== null &&
        now - lastTier1StartedAtMsRef.current < MIN_GAP_BETWEEN_TIER1_CALLS_MS
      ) {
        return // too soon — the accumulated turns stay queued for the next successful trigger
      }
      const turns = pendingTier1TurnsRef.current
      const engine = engineRef.current
      if (turns.length === 0 || !engine) return

      tier1InFlightRef.current = true
      lastTier1StartedAtMsRef.current = now
      const myGeneration = generationRef.current
      pendingTier1TurnsRef.current = [] // new turns accumulate fresh while this pass is in flight

      const transcriptDelta = turns
        .map(
          (t) => `${t.role === 'rep' ? 'Rep' : t.role === 'other' ? 'Buyer' : 'Speaker'}: ${t.text}`
        )
        .join('\n')
      const compactState = summarizeLiveCallState(engine.state)
      const latestRepText = turns
        .filter((t) => t.role === 'rep')
        .map((t) => t.text)
        .join(' ')

      try {
        // M26 4.5 (BUG-055) — precise per-turn check: any turn in THIS batch
        // attributed to the buyer means main must verify consent is
        // currently active before the batch reaches a prompt. `role` is
        // decided at record time and never a diarization guess reused as a
        // consent signal (BUG-002's own lesson).
        const outcome = await analyzeTier1({
          transcriptDelta,
          compactState,
          dealContext: dealContextRef.current,
          triggerReason,
          sessionId: getSessionId() ?? undefined,
          includesBuyerContent: turns.some((t) => t.role === 'other')
        })
        if (myGeneration !== generationRef.current) return // stale — reset() ran mid-flight

        if (!outcome.ok) {
          // BUG-057 Phase 2 — three-way, not a boolean-shaped ternary: a
          // 'timed-out' result used to fall to 'active' here, actively
          // claiming "working fine" for a pass that just failed — worse
          // than the coaching-cue side's old bug, which merely failed to
          // distinguish the reason rather than reporting the wrong status
          // outright.
          setStatus(
            outcome.pausedReason === 'all-models-unavailable'
              ? 'paused'
              : outcome.pausedReason === 'timed-out'
                ? 'timed-out'
                : 'active'
          )
          return
        }
        setStatus('active')

        // §10 — a type the rep turned off is filtered out here, before it
        // ever reaches the Nudge Engine, not just hidden in the UI after
        // the fact (the engine's cooldown/dedupe bookkeeping shouldn't
        // spend its budget on a type the rep doesn't want to see at all).
        const allowedCandidates = outcome.candidates.filter((c) => enabledTypesRef.current[c.type])

        const { state: nextNudgeState, surfaced } = evaluateSignals(
          nudgeStateRef.current,
          allowedCandidates,
          { sensitivity: sensitivityRef.current, feedback: feedbackAdjustmentsRef.current },
          now,
          latestRepText || lastRepTextRef.current
        )
        nudgeStateRef.current = nextNudgeState
        if (surfaced) setNudges(nextNudgeState.visibleNudges)
      } finally {
        if (myGeneration === generationRef.current) tier1InFlightRef.current = false
      }
    },
    [enabled, getSessionId]
  )

  const runTier2Pass = useCallback(
    async (triggerReason: string) => {
      if (!enabled || tier2InFlightRef.current) return
      const now = Date.now()
      if (
        lastTier2StartedAtMsRef.current !== null &&
        now - lastTier2StartedAtMsRef.current < MIN_GAP_BETWEEN_TIER2_CALLS_MS
      ) {
        return
      }
      const turns = pendingTier2TurnsRef.current
      const engine = engineRef.current
      if (turns.length === 0 || !engine) return

      tier2InFlightRef.current = true
      lastTier2StartedAtMsRef.current = now
      const myGeneration = generationRef.current
      pendingTier2TurnsRef.current = []

      const transcriptDelta = turns
        .map(
          (t) => `${t.role === 'rep' ? 'Rep' : t.role === 'other' ? 'Buyer' : 'Speaker'}: ${t.text}`
        )
        .join('\n')
      const compactState = summarizeLiveCallState(engine.state)

      try {
        // M26 4.5 (BUG-055) — see the identical check in runTier1Pass above.
        const outcome = await analyzeTier2({
          transcriptDelta,
          compactState,
          dealContext: dealContextRef.current,
          triggerReason,
          sessionId: getSessionId() ?? undefined,
          includesBuyerContent: turns.some((t) => t.role === 'other')
        })
        if (myGeneration !== generationRef.current) return

        if (!outcome.ok) {
          // BUG-057 Phase 2 — three-way, not a boolean-shaped ternary: a
          // 'timed-out' result used to fall to 'active' here, actively
          // claiming "working fine" for a pass that just failed — worse
          // than the coaching-cue side's old bug, which merely failed to
          // distinguish the reason rather than reporting the wrong status
          // outright.
          setStatus(
            outcome.pausedReason === 'all-models-unavailable'
              ? 'paused'
              : outcome.pausedReason === 'timed-out'
                ? 'timed-out'
                : 'active'
          )
          return
        }
        setStatus('active')

        const sanitized = sanitizeHealthScoreResponse(
          {
            score: outcome.score,
            factors: outcome.factors,
            topRecommendation: outcome.topRecommendation
          },
          now,
          healthScoreRef.current?.score ?? null
        )
        if (sanitized) {
          healthScoreRef.current = sanitized
          setHealthScore(sanitized)
          const startedAt = callStartWallClockRef.current
          if (startedAt !== null) {
            healthScoreHistoryRef.current = [
              ...healthScoreHistoryRef.current,
              {
                score: sanitized.score,
                trajectory: sanitized.trajectory,
                atMs: Math.max(0, now - startedAt)
              }
            ].slice(-MAX_RADAR_REPORT_HEALTH_POINTS)
          }
        }
      } finally {
        if (myGeneration === generationRef.current) tier2InFlightRef.current = false
      }
    },
    [enabled, getSessionId]
  )

  // The ~20s Tier 1 idle cadence — fires regardless of Tier 0 activity, so a
  // quiet stretch with no deterministic trigger still gets looked at. Scaled
  // by §10's frequency setting; re-running this effect on a mid-call
  // frequency change restarts the timer at the new cadence rather than
  // waiting out whatever was left of the old one.
  useEffect(() => {
    if (!enabled || !active) return
    const id = setInterval(() => {
      void runTier1Pass('Routine check-in')
    }, TIER1_INTERVAL_MS * FREQUENCY_MULTIPLIER[frequency])
    return () => clearInterval(id)
  }, [enabled, active, runTier1Pass, frequency])

  // The ~2.5min Tier 2 idle cadence — the stage-change trigger (in the
  // segment-processing effect below) covers the other half of §4's "every
  // 2-3 minutes OR on stage change."
  useEffect(() => {
    if (!enabled || !active) return
    const id = setInterval(() => {
      void runTier2Pass('Routine check-in')
    }, TIER2_INTERVAL_MS * FREQUENCY_MULTIPLIER[frequency])
    return () => clearInterval(id)
  }, [enabled, active, runTier2Pass, frequency])

  // Folds every newly-arrived segment into the Live Call State engine, fires
  // a Tier 1 pass the moment any Tier 0 signal comes out of that fold, and a
  // Tier 2 pass the moment the fold changes callStage. Also owns the
  // once-per-call context-fusion fetch (§5), fired the same lazy-init moment
  // the engine itself is created. Reads `segments` fresh each render rather
  // than diffing inside a ref-only callback, matching how the rest of this
  // hook already treats React state as the source of truth for "what changed."
  useEffect(() => {
    if (!enabled || !active) return

    if (callStartWallClockRef.current === null) {
      callStartWallClockRef.current = Date.now()
      engineRef.current = new LiveCallStateEngine(0, { agendaTopics: agendaTopicsRef.current })
      processedCountRef.current = 0
      // Fire-and-forget: Tier 1/2 calls that fire before this resolves just
      // run without deal-specific grounding this pass — never blocks
      // analysis on a context fetch, since "no context" is a normal,
      // common, non-error state (see contextFusion.ts).
      void buildDealContext(meetingRef.current).then((ctx) => {
        dealContextRef.current = ctx.text
      })
      // Same fire-and-forget posture as context fusion above — a Tier 1
      // pass that fires before this resolves just uses the un-adjusted
      // sensitivity floor this once, not a reason to block analysis.
      void window.api.dealIntelligence
        .getFeedbackSummary()
        .then((summary) => {
          feedbackAdjustmentsRef.current = summary
        })
        .catch(() => {})
    }
    const engine = engineRef.current
    const startedAt = callStartWallClockRef.current
    if (!engine || startedAt === null) return

    const newSegments = segments.slice(processedCountRef.current)
    processedCountRef.current = segments.length
    if (newSegments.length === 0) return

    const stageBefore = engine.state.callStage
    if (lastCallStageRef.current === null) lastCallStageRef.current = stageBefore

    let tier0Fired = false
    for (const seg of newSegments) {
      if (seg.kind === 'gap' || !seg.role) continue
      const atMs = Date.now() - startedAt
      const turn: LiveTurn = {
        speaker: seg.speaker,
        text: seg.text,
        role: seg.role,
        atMs,
        epoch: seg.epoch,
        channel: seg.channel
      }
      const signals = engine.ingest(turn)
      pendingTier1TurnsRef.current = [...pendingTier1TurnsRef.current, turn].slice(
        -MAX_TIER1_DELTA_TURNS
      )
      pendingTier2TurnsRef.current = [...pendingTier2TurnsRef.current, turn].slice(
        -MAX_TIER2_DELTA_TURNS
      )
      if (seg.role === 'rep') lastRepTextRef.current = seg.text
      if (signals.length > 0) tier0Fired = true
    }

    if (tier0Fired) void runTier1Pass('A Tier 0 signal fired')

    if (engine.state.callStage !== lastCallStageRef.current) {
      const from = lastCallStageRef.current
      lastCallStageRef.current = engine.state.callStage
      void runTier2Pass(`Call stage changed from ${from} to ${engine.state.callStage}`)
    }
  }, [segments, enabled, active, runTier1Pass, runTier2Pass])

  const dismissNudge = useCallback((id: string) => {
    nudgeStateRef.current = dismissNudgeFromState(nudgeStateRef.current, id)
    setNudges(nudgeStateRef.current.visibleNudges)
  }, [])

  const rateNudge = useCallback((id: string, helpful: boolean) => {
    // Look across the FULL history, not just visibleNudges — a rep can
    // still rate a nudge from the evidence view after it's auto-dismissed.
    const nudge = nudgeStateRef.current.history.find((n) => n.id === id)
    if (!nudge) return
    nudgeFeedbackRef.current.set(id, helpful ? 'helpful' : 'not-helpful')
    void window.api.dealIntelligence
      .recordFeedback({ type: nudge.type, subtype: nudge.subtype, helpful })
      .catch(() => {})
  }, [])

  const getDealIntelligenceReport = useCallback((): DealIntelligenceRecord => {
    const fresh = computeReport()
    // Reference-identity check against the sentinel, not a shape check —
    // computeReport() returns this exact object only when there's no live
    // call to read from (see its own doc comment).
    return fresh !== EMPTY_REPORT ? fresh : finalizedReportRef.current
  }, [computeReport])

  return { status, nudges, dismissNudge, healthScore, rateNudge, getDealIntelligenceReport }
}
