import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MIC_OUTCOME_TEXT } from '@renderer/features/audio/micOutcome'
import {
  Mic,
  Square,
  Pause,
  Play,
  AlertTriangle,
  MicOff,
  Loader2,
  Bookmark,
  Sparkles
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { isMac, isWindows } from '@renderer/lib/platform'
import { IconButton } from '@renderer/components/IconButton'
import { Button } from '@renderer/components/Button'
import type { ConsentMethod } from '@renderer/features/calls/types'
import type { DealIntelligenceRecord } from '../../../../preload/index.d'
import { useLiveClips } from './useLiveClips'
import { useLiveCall } from './useLiveCall'
import { useAutoStartListening } from '@renderer/features/settings/useAutoStartListening'
import { IdleStopWatcher, idleStopNotice } from './auto-stop'
import { MustAskChecklist, emptyChecklistState, preHangupWarning } from './checklist/must-ask'
import { MustAskStrip } from './components/MustAskStrip'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import { getExcludedApps, addSeenApp } from '@renderer/features/settings/prefs'
import { OtherPartyControl } from '@renderer/features/consent/OtherPartyControl'
import { detectOutputDevice } from '@renderer/features/audio/headphones'
import { capturedJustWentLive, playCaptureLiveChime } from './audio/capture-chime'
import { ConsentModal } from '@renderer/features/consent/ConsentModal'
import { RecordingIndicator } from '@renderer/features/consent/RecordingIndicator'
import { useCalendar } from '@renderer/features/calendar/useCalendar'
import type { CalendarEvent } from '@renderer/features/calendar/types'
import { PrepBriefModal, type PrepBriefMeeting } from '@renderer/features/prep-brief/PrepBriefModal'
import { Waveform } from './components/Waveform'
import { TranscriptView } from './components/TranscriptView'
import { shouldOfferPostCallExit } from './post-call-exit'
import { CueCard } from './components/CueCard'
import { SuggestionRail } from './components/SuggestionRail'
import { CueControls } from './components/CueControls'
import { AskCoach } from './components/AskCoach'
import { EngagementGauge } from './components/EngagementGauge'
import { MonologueMeter } from './components/MonologueMeter'
import { DealIntelligencePanel } from '@renderer/features/deal-intelligence/ui/DealIntelligencePanel'
import { QuietToggle } from './components/QuietToggle'
import { DealFactsLine } from './components/DealFactsLine'
import { useLiveDealFacts } from './useLiveDealFacts'
import { PostCallReasonBanner } from './components/PostCallReasonBanner'
import { resolvePostCallReason, type PostCallReasonDecision } from './post-call-reason'
import {
  IdleHero,
  AttachingState,
  CenteredState,
  DeniedState,
  NoKeyState,
  StatusBadge,
  InlineBanner
} from './components/LiveStates'
import { sessionHealthNotice } from './session-health-notice'
import { lowCaptureNotice } from './low-capture-notice'

/** BUG-172 — how long to wait for the call id before giving up and SAYING SO.
 *  Measured on a cold launch: the id lands within a few hundred ms of the
 *  socket reporting 'listening'. Ten tries at 250ms is 2.5 seconds, which is
 *  generous against that and still short enough that a rep who genuinely
 *  cannot capture the buyer is told at the START of the call rather than
 *  discovering it in the transcript afterwards. */
const BUYER_CALLID_RETRY_MS = 250
/** Wall-clock, not attempts. The call id arrives with the FIRST TRANSCRIPT
 *  PATCH — i.e. when somebody first speaks — so the wait has to cover a rep
 *  who presses Start and then greets the buyer, which is the normal way a call
 *  begins. 30s is generous against that and still bounded, so a machine that
 *  genuinely cannot capture is told rather than waiting forever. */
const BUYER_CALLID_MAX_WAIT_MS = 30_000

interface LiveViewProps {
  /** AI Note Taker's "auto-open meeting page" — called with the saved call's
   *  id right after a successful save. Optional so LiveView still works
   *  standalone (e.g. in tests) without a parent wiring navigation. */
  onSaved?: (callId: string) => void
  /** One-shot: true when the parent navigated here because the rep either
   *  clicked "Start transcribing" on a detected-call banner, or has the
   *  Auto-transcribe setting on and a known calling app was just detected.
   *  Distinct from the general auto-start-listening setting below — this
   *  fires once per detection, not on every Live Calls visit, and (being an
   *  explicit confirmation or an explicit opt-in setting) doesn't consult
   *  the auto-start exclusion list. */
  autoStartFromDetection?: boolean
  /** Called once autoStartFromDetection has been acted on, so the parent can
   *  clear the flag (otherwise a later plain visit would auto-start again). */
  onAutoStartFromDetectionConsumed?: () => void
  /** Ambient call detection (M15): one-shot, set when the main process's
   *  CallDetector decided to start capturing a call it noticed on its own.
   *  `mode` is informational only here - 'full' vs 'mic-only' is entirely
   *  governed by the existing per-call consent flow below, unchanged. */
  ambientAutoStart?: { callId: string; mode: 'full' | 'mic-only' } | null
  /** Called once ambientAutoStart has been acted on, so the parent can clear it. */
  onAmbientAutoStartConsumed?: () => void
  /** Reports back whether the ambient-triggered start actually succeeded, so
   *  the parent can ack detection-service.ts via window.api.detection.captureStarted/captureFailed. */
  onAmbientAutoStartResult?: (
    result: { callId: string } & ({ ok: true; sessionId: number } | { ok: false })
  ) => void
  /** Nonces (increment on each request) from the ambient-detection overlay banner's
   *  Stop/Pause buttons - a different window than this one, so it can't call stop()/
   *  togglePause() directly. Each change is acted on exactly once. */
  remoteStopToken?: number
  remotePauseToken?: number
}

export function LiveView({
  onSaved,
  autoStartFromDetection = false,
  onAutoStartFromDetectionConsumed,
  ambientAutoStart = null,
  onAmbientAutoStartConsumed,
  onAmbientAutoStartResult,
  remoteStopToken = 0,
  remotePauseToken = 0
}: LiveViewProps): React.JSX.Element {
  const appSettings = useAppSettings().settings
  const allowOtherPartyRecording = appSettings.allowOtherPartyRecording

  // M26 Phase 4.4 — consent and the transcription session both live in
  // LiveCallProvider now (mounted once in App.tsx, above the navigation
  // boundary), so they survive this component unmounting on every screen
  // switch. See LiveCallProvider.tsx's file header for why that had to be a
  // whole-hook hoist rather than just moving the Recorder object.
  const liveCall = useLiveCall()
  const { consent, buyerIdentityRef, setOnSaved } = liveCall
  const [consentOpen, setConsentOpen] = useState(false)

  // "Clip this" — a local, in-memory clip buffer (no callId exists yet for a
  // live-in-progress call). Flushed to real bookmarks once the call is saved.
  const clips = useLiveClips()

  // M24 §8 — same cross-hook-ordering problem M19's buyerIdentityRef below
  // already solves, one level removed: useDealIntelligence (which must run
  // AFTER useTranscription, since it reads useTranscription's own return
  // values) can't be called yet at the point handleSaved is defined, so its
  // getDealIntelligenceReport function is bridged in via a ref instead —
  // synced once useDealIntelligence exists (see the effect near that call),
  // read here only at actual save time, well after that sync has happened.
  const dealIntelligenceReportGetterRef = useRef<() => DealIntelligenceRecord>(() => ({
    nudges: [],
    healthScoreHistory: []
  }))

  // Wrap the parent's onSaved so every clip captured this call is flushed to
  // window.api.calls.addBookmark against the now-real callId, fire-and-forget,
  // before handing off to whatever the parent wants to do with the saved id.
  // M31 Slice B — the meeting that was running when this call was recorded.
  // Ref-bridged for the same reason dealIntelligenceReportGetterRef above is:
  // handleSaved is a useCallback that must not re-create on every calendar
  // tick, so reading currentMeeting directly would capture a stale value.
  const currentMeetingRef = useRef<CalendarEvent | null>(null)

  // M34 3e — the reason prompt at call end. Decided ONCE per saved call from
  // records (the saved call's deal, else the matched meeting's), rendered
  // under the "call has ended" banner, cleared when answered, skipped, or the
  // banner is dismissed. Never blocks: Done works regardless.
  const [postCallReason, setPostCallReason] = useState<PostCallReasonDecision | null>(null)

  const handleSaved = useCallback(
    (callId: string) => {
      clips.flush(callId)
      void resolvePostCallReason(callId, currentMeetingRef.current?.dealId).then(setPostCallReason)
      const report = dealIntelligenceReportGetterRef.current()
      if (report.nudges.length > 0 || report.healthScoreHistory.length > 0) {
        void window.api.calls.saveDealIntelligence(callId, report).catch(() => {})
      }
      // Join the plan to its outcome, at the one moment the join is a FACT
      // rather than a guess: the app already knows which meeting is running,
      // so record it instead of trying to infer it later from contact + time
      // overlap (which breaks on back-to-back calls, overruns, and calls made
      // to someone else mid-meeting). Fire-and-forget: a missed link costs a
      // marker on a calendar chip, and must never interfere with saving the
      // call itself, which is the part that actually matters.
      const meeting = currentMeetingRef.current
      if (meeting && meeting.source === 'local') {
        void window.api.events.update(meeting.id, { callId }).catch(() => {})
      }
      onSaved?.(callId)
    },
    [clips, onSaved]
  )

  // M19 Task 2 step 5 — bridges useLiveCues' self-intro extraction (below,
  // must run AFTER this destructure per hooks' call-order rules) into
  // useTranscription's save flow. Lives in the Provider now (see
  // LiveCallProvider.tsx) because useTranscription itself does; destructured
  // above alongside `consent`.

  // M26 Phase 4.4 — handleSaved is registered with the Provider rather than
  // passed as a constructor argument, because useTranscription is no longer
  // instantiated here. Deliberately no cleanup on unmount — see
  // LiveCallProvider.tsx's setOnSaved doc comment for why that's correct
  // rather than a missing unsubscribe.
  useEffect(() => {
    setOnSaved(handleSaved)
  }, [setOnSaved, handleSaved])

  // M26 Phase 4.4 — "the view went away" as an event distinct from "the call
  // ended", which is the whole point of this phase (BUG-046 was exactly that
  // conflation). Nothing else in this cleanup: the Recorder, the socket, and
  // the transcript all live in LiveCallProvider now and are untouched by this
  // component unmounting. The Provider's OWN unmount cleanup (inside
  // useTranscription — unmodified by this phase, see its file for why) still
  // covers the rare case where the call genuinely must end without this
  // screen's involvement, such as signing out mid-call.
  useEffect(() => {
    return () => {
      void window.api.transcription.detach()
    }
  }, [])

  const {
    status,
    segments,
    interimText,
    latencyMs,
    health,
    errorMessage,
    analyser,
    savedNotice,
    otherPartyLive,
    otherPartyError,
    setOtherPartyNotReady,
    micPrompting,
    briefCopied,
    buyerSilentWarning,
    dismissBuyerSilentWarning,
    crossTalkWarning,
    dismissCrossTalkWarning,
    multichannelFallbackNotice,
    dismissMultichannelFallbackNotice,
    start,
    getSessionId,
    getCallId,
    stop,
    dismissFinishedCall,
    togglePause,
    enableOtherParty,
    disableOtherParty
  } = liveCall

  // M19 Task 3B — "show the prep brief again at call start": whichever
  // calendar event is happening right now (or started in the last 10
  // minutes — the common case of clicking Start a beat after the meeting
  // actually began), surfaced as a banner above the idle hero so the rep
  // doesn't have to go find it in Calendar. Read-only, local-cache-only
  // (useCalendar's initial load never hits the network), so this costs
  // nothing extra beyond what Calendar itself already fetches.
  const { events: calEvents, googleEvents, outlookEvents } = useCalendar()
  const [prepBriefMeeting, setPrepBriefMeeting] = useState<PrepBriefMeeting | null>(null)
  // Date.now() is impure, so "is a meeting happening right now" can't be a
  // useMemo (which runs during render) — it has to live in an effect.
  const [currentMeeting, setCurrentMeeting] = useState<CalendarEvent | null>(null)
  // M34 3d — the deal facts for the matched meeting, resolved ONCE per
  // meeting and never refreshed mid-call (see useLiveDealFacts).
  const dealFacts = useLiveDealFacts(currentMeeting)
  useEffect(() => {
    const now = Date.now()
    const all = [...calEvents, ...googleEvents, ...outlookEvents]
    const match = all.find((e) => {
      if (e.allDay) return false
      const start = new Date(e.start).getTime()
      const end = new Date(e.end).getTime()
      if (!Number.isFinite(start) || !Number.isFinite(end)) return false
      return now >= start - 10 * 60_000 && now <= end
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Date.now() forces this out of render; syncing derived state from the calendar data is exactly what an effect is for
    setCurrentMeeting(match ?? null)
    currentMeetingRef.current = match ?? null
    // M26 4.5 — mirror into the Provider's own useDealIntelligence instance,
    // which now lives above this screen and needs the same value. Calendar
    // matching itself stays here (needs useCalendar(), a screen concern);
    // only the RESULT is bridged, the same shape setOnSaved bridges a
    // callback.
    liveCall.setCurrentMeeting(match ?? null)
  }, [calEvents, googleEvents, outlookEvents, liveCall])

  // M19 Task 2 Part A — per-channel attribution is only deterministic on
  // headphones; on speakers the buyer's voice leaks back into the mic. Best-
  // effort device-label heuristic, checked once buyer capture actually goes
  // live (the one moment this actually matters) — never checked continuously,
  // and 'unknown' (can't tell) deliberately never warns, so a real headphone
  // setup this heuristic doesn't recognize is never falsely flagged.
  const [speakerModeWarning, setSpeakerModeWarning] = useState(false)
  useEffect(() => {
    if (!otherPartyLive) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears with buyer capture, same as the other live-only warnings on this screen
      setSpeakerModeWarning(false)
      return
    }
    let cancelled = false
    void detectOutputDevice().then((verdict) => {
      if (!cancelled && verdict === 'speakers') setSpeakerModeWarning(true)
    })
    return () => {
      cancelled = true
    }
  }, [otherPartyLive])

  // Elapsed-time clock for clips: no callId (or playback position) exists yet
  // for a live call, so track wall-clock elapsed-since-start locally instead.
  // Resets whenever the call goes back to idle; starts on the first non-idle
  // status of a fresh session (also clears any clips left from a prior call).
  const callStartRef = useRef<number | null>(null)
  useEffect(() => {
    // M26 4.3 — 'attaching' is neither "a call started" nor "no call". Falling
    // into the else-branch here at mount would stamp a fresh call start AND
    // call clips.reset(), silently discarding every bookmark the rep had
    // clicked in the call we are in the middle of re-attaching to.
    if (status === 'attaching') return
    if (status === 'idle') {
      callStartRef.current = null
    } else if (callStartRef.current === null) {
      callStartRef.current = Date.now()
      clips.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clips' identity is stable (useCallback-memoized); only `status` should retrigger this
  }, [status])

  const handleClip = useCallback(() => {
    const elapsed = callStartRef.current !== null ? Date.now() - callStartRef.current : 0
    clips.captureClip(elapsed, segments, interimText)
  }, [clips, segments, interimText])

  // M26 4.5 (BUG-055) — both engines now live in LiveCallProvider, for the
  // same reason and the same way the transcript does: their timing-dependent
  // state must survive a navigation and an ordinary mid-call restart, not
  // reset on either. This screen is a pure attach/subscribe client for them
  // now, same shape it already is for the transcript.
  const { enabled, setEnabled, sensitivity, setSensitivity, quiet, setQuiet } =
    liveCall.cueSettings
  const {
    cue,
    dismiss,
    suggestions,
    dismissSuggestion,
    repSpeaker,
    engagementScore,
    monologue,
    buyerName,
    buyerIdentityKey,
    coachingPaused,
    coachingPausedReason
  } = liveCall.cues

  // M24 — Live Deal Intelligence (Beta).
  const { enabled: dealIntelligenceEnabled } = liveCall.dealIntelligenceSettings
  const {
    status: dealIntelligenceStatus,
    nudges: dealIntelligenceNudges,
    dismissNudge: dismissDealIntelligenceNudge,
    healthScore: dealIntelligenceHealthScore,
    rateNudge: rateDealIntelligenceNudge,
    getDealIntelligenceReport
  } = liveCall.dealIntelligence
  // Completes the ref bridge declared above handleSaved — kept in sync on
  // every render rather than a mount-only effect, since getDealIntelligenceReport's
  // own identity can change (e.g. across the per-call reset this hook does internally).
  useEffect(() => {
    dealIntelligenceReportGetterRef.current = getDealIntelligenceReport
  }, [getDealIntelligenceReport])

  // Keep the save-time ref in sync with the live-resolved buyer name, and
  // build the identities map SpeakerTranscript needs to show it DURING the
  // call (not just after saving) — the M19 brief's "propagates to the live
  // transcript" requirement.
  useEffect(() => {
    buyerIdentityRef.current =
      buyerName && buyerIdentityKey ? { key: buyerIdentityKey, name: buyerName } : null
  }, [buyerName, buyerIdentityKey, buyerIdentityRef])
  const liveIdentities = useMemo(
    () =>
      buyerName && buyerIdentityKey
        ? {
            [buyerIdentityKey]: {
              name: buyerName,
              source: 'self-intro' as const,
              confidence: 'medium' as const
            }
          }
        : undefined,
    [buyerName, buyerIdentityKey]
  )

  // When a call is saved, consent resets to off so it never carries to the next.
  const resetConsent = consent.reset
  useEffect(() => {
    if (savedNotice) resetConsent()
  }, [savedNotice, resetConsent])

  // Buyer capture follows consent: turned ON from the modal's "yes" gesture;
  // turned OFF here whenever consent is no longer granted (declined / turned off
  // / per-call reset). disableOtherParty is idempotent, so this is safe to fire
  // on every consent change, including the double reset on save + start.
  const canRecordOther = consent.canRecord
  useEffect(() => {
    if (!canRecordOther) {
      // Revoked, declined, or reset for the next call — drop the durable grant
      // too, or a record from a finished call would still satisfy the gate.
      window.api.consent.clear()
      void disableOtherParty()
    }
  }, [canRecordOther, disableOtherParty])

  // Standing consent means nobody clicks "they said yes" on this call, so the
  // buyer side has to be picked up on its own once the session is live.
  //
  // Exactly one attempt per call. getDisplayMedia wants a recent user gesture,
  // and an auto-started call (ambient detection) may have none — so this can
  // legitimately fail. When it does, `otherPartyError` renders the existing
  // recovery banner, whose "Try again" IS a gesture and always works. Retrying
  // in a loop here would just spam a prompt that cannot succeed.
  /** BUG-173 — "is a call actually on screen right now". Named once rather
   *  than re-derived per element, because the Deal Intelligence panel was
   *  missing exactly this check and nothing made that visible. */
  const liveSurfaceVisible =
    status === 'listening' || status === 'connecting' || status === 'reconnecting' || status === 'paused'

  const autoBuyerAttemptedRef = useRef(false)
  /** BUG-172 — how many times we have waited for the call id this call, and a
   *  tick that re-runs the effect when it might have arrived. getCallId() reads
   *  a REF by design and can never itself trigger a re-render, so without this
   *  there is nothing to bring the effect back. */
  const buyerWaitStartRef = useRef(0)
  const [buyerRetryTick, setBuyerRetryTick] = useState(0)
  useEffect(() => {
    if (status === 'idle') {
      autoBuyerAttemptedRef.current = false
      buyerWaitStartRef.current = 0
    }
  }, [status])
  useEffect((): undefined | (() => void) => {
    if (autoBuyerAttemptedRef.current) return undefined
    if (status !== 'listening' || !canRecordOther || otherPartyLive || otherPartyError) return undefined

    // BUG-172 — THE CALL ID MAY NOT EXIST YET, AND THAT IS NOT A FAILURE.
    //
    // This effect fires the moment the socket reports 'listening'. On a cold
    // launch that happens BEFORE the call record is written, so getCallId()
    // is still null, consent.persist is handed an empty id and returns false.
    // The old code had already set autoBuyerAttemptedRef above this point, so
    // the one attempt per call was spent on a precondition that simply had
    // not arrived yet — and because nothing set otherPartyError, the recovery
    // banner never appeared either. The call then recorded ONLY THE REP for
    // its entire duration while consent.recordOtherParty said true.
    //
    // The id arrives milliseconds later, so this is a WINDOW, not a state:
    // wait for it rather than burning the attempt. The founder confirmed the
    // shape from the outside — 1st call one-sided, 3rd call both sides.
    const callIdNow = getCallId()
    if (!callIdNow) {
      // TIME, not attempt count. The counter used to increment on every effect
      // RUN, and the effect re-runs whenever any dependency changes — so ten
      // "waits" were once observed burning in four milliseconds, exhausting the
      // budget before a single timer fired. Only the timer advances the clock.
      if (buyerWaitStartRef.current === 0) buyerWaitStartRef.current = Date.now()
      if (Date.now() - buyerWaitStartRef.current >= BUYER_CALLID_MAX_WAIT_MS) {
        // It never arrived. Say so BEFORE the call ends, never after: a call
        // that silently records half of what it promised is worse than one
        // that admits it cannot.
        autoBuyerAttemptedRef.current = true
        setOtherPartyNotReady()
        return undefined
      }
      const t = setTimeout(() => setBuyerRetryTick((n) => n + 1), BUYER_CALLID_RETRY_MS)
      return () => clearTimeout(t)
    }

    // Only NOW is this a real attempt.
    autoBuyerAttemptedRef.current = true
    // Standing consent still has to be written before capture can be armed —
    // the gate does not care WHERE the consent came from, only that a record
    // for this call exists on disk. M27 E1 — keyed on callId, not sessionId
    // (see main/consent-gate.ts's own doc comment for why).
    //
    // 1.2.6 hotfix (privacy) — ARM ONLY IF THE CONSENT ACTUALLY LANDED. This
    // ran enableOtherParty() unconditionally, so a persist that failed still
    // armed capture — and the audio gate, which asks only whether ANY consent
    // exists, could then open on a grant left over from an earlier call.
    //
    // MERGE NOTE: both halves are load-bearing and neither version alone is
    // correct. 1.3.0 supplies the right KEY (callId, which survives a
    // mono<->multichannel restart; sessionId does not — that was BUG-063),
    // and 1.2.6 supplies the GUARD. Taking either side wholesale would have
    // silently dropped the other.
    // callIdNow, not getCallId() again: the value validated a few lines above
    // is the one this attempt is FOR. Re-reading invites the same class of bug
    // this fix exists for.
    if (!window.api.consent.persist(callIdNow, consent.recordRef.current)) {
      // The id existed and the write still failed — that is a real refusal, not
      // a timing window, and it must not be silent either.
      setOtherPartyNotReady()
      return undefined
    }
    void enableOtherParty()
    return undefined
  }, [
    status,
    canRecordOther,
    otherPartyLive,
    otherPartyError,
    enableOtherParty,
    getCallId,
    buyerRetryTick,
    setOtherPartyNotReady,
    consent.recordRef
  ])

  // Audible confirmation the instant buyer capture actually goes live — for a
  // rep who isn't looking at the screen when the other party picks up. Fires
  // only on the true→ transition, never on every render where it's already on.
  const otherPartyLiveRef = useRef(false)
  useEffect(() => {
    if (capturedJustWentLive(otherPartyLiveRef.current, otherPartyLive)) {
      playCaptureLiveChime()
    }
    otherPartyLiveRef.current = otherPartyLive
  }, [otherPartyLive])

  // Settings master switch: when off, the whole other-party recording feature
  // is unavailable — no control to open the modal, the modal itself never
  // renders, and any capture already running is stopped. This can only ever
  // remove capability (see useAppSettings' safe default + app-settings.ts);
  // the per-call consent checks above are unchanged and still fully apply
  // whenever the switch is on.
  useEffect(() => {
    if (!allowOtherPartyRecording) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- force-close the modal/consent when the master switch flips off mid-session
      setConsentOpen(false)
      consent.turnOff()
      void disableOtherParty()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowOtherPartyRecording, disableOtherParty])

  // An auto-started call has to be able to END by itself too. The app-name
  // detector only ever announces a START, so before this an auto-started
  // session ran until someone opened the app and pressed Stop — and since the
  // call is only written to disk when the session closes, "nobody pressed
  // Stop" meant the call was never saved at all.
  //
  // Armed only for calls the app started itself: a rep who pressed Start is
  // present and in control, and timing them out mid-thought would be a
  // surprise rather than a rescue.
  // The must-ask checklist (§4.5). Ambient: it fills in as the call goes and
  // says nothing until the rep is about to hang up.
  const checklistRef = useRef(new MustAskChecklist())
  // How many of `segments` have already been scored against the checklist —
  // reset alongside checklistRef.current.reset() below, so a new call's
  // segment count (starting back at 0) is never compared against a stale
  // count left over from the previous call.
  const scoredSegmentCountRef = useRef(0)
  // Seeded from the module, not from the ref — reading a ref during render is
  // exactly the pattern that makes concurrent rendering tear.
  const [checklist, setChecklist] = useState(emptyChecklistState)

  const idleWatcherRef = useRef(new IdleStopWatcher())
  // BUG-158 — how much of the transcript column the floating Live Deal
  // Intelligence panel is currently covering.
  //
  // MEASURED, not assumed: the panel is mounted `absolute top-3 left-4 w-80`
  // over this same column, and its height is not a constant — driving one call
  // showed it grow from 37px to 91px as nudges accumulated, covering more
  // transcript as it went. A hard-coded reservation would be wrong within
  // seconds of a real call starting.
  //
  // The hook is unconditional on purpose. Putting it behind
  // `dealIntelligenceEnabled` would change the hook order the moment the beta
  // flag flips mid-session.
  // A CALLBACK REF, not useRef + useEffect, and the difference is the whole
  // reason this works.
  //
  // The first version kept a plain ref and observed it from an effect keyed on
  // `dealIntelligenceEnabled`. That effect runs while the panel is still
  // UNMOUNTED — the wrapper only appears once a call is running — so it read a
  // null ref, set 0, and never re-ran, because the flag it depended on had not
  // changed. Verified against the live app: the transcript kept
  // `padding-top: 24px` with no inline style at all, i.e. the reservation was
  // silently zero the entire time.
  //
  // A callback ref is invoked by React exactly when the node attaches and
  // again with null when it detaches, so the observer is wired at the only
  // moment it can be, without depending on anything else being right.
  const [dealPanelHeight, setDealPanelHeight] = useState(0)
  const dealPanelObserver = useRef<ResizeObserver | null>(null)
  const dealPanelRef = useCallback((el: HTMLDivElement | null) => {
    dealPanelObserver.current?.disconnect()
    dealPanelObserver.current = null
    if (!el) {
      setDealPanelHeight(0)
      return
    }
    const update = (): void => setDealPanelHeight(el.getBoundingClientRect().height)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    dealPanelObserver.current = ro
  }, [])

  // BUG-165 — the same defect as BUG-158, on the other axis and the other
  // element. The coaching-cue column is mounted `absolute top-3 right-4
  // bottom-4 w-64` OVER this transcript. Its own comment says the two cue
  // channels "share a single bottom-anchored stack so they cannot COLLIDE" —
  // true, and about each other. Nothing considered the transcript underneath.
  //
  // At 1280px the text column is wide enough that lines stop short of the
  // rail, which is why it looked fine. Measured on a driven call at narrower
  // widths, with elementFromPoint at each line's centre: 4 transcript lines
  // unreachable at 1100px, 3 at 980px, 1 at 860px and 720px. On screen the
  // cue and the transcript render THROUGH each other and neither is legible.
  // 1100px is an ordinary window, not an edge case.
  //
  // Reserved by MEASURED width for the same reason the panel above is
  // measured by height: the rail is `w-64` today, but a reservation that
  // hard-codes 256 is a second source of truth that goes stale silently the
  // first time that class changes. Callback ref, not useRef + effect — see
  // the note on dealPanelRef for what that mistake cost.
  const [cueRailWidth, setCueRailWidth] = useState(0)
  const cueRailObserver = useRef<ResizeObserver | null>(null)
  const cueRailRef = useCallback((el: HTMLDivElement | null) => {
    cueRailObserver.current?.disconnect()
    cueRailObserver.current = null
    if (!el) {
      setCueRailWidth(0)
      return
    }
    const update = (): void => setCueRailWidth(el.getBoundingClientRect().width)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    cueRailObserver.current = ro
  }, [])

  const [autoStopNotice, setAutoStopNotice] = useState<string | null>(null)
  /** What the rep never asked, captured at the moment they hang up. */
  const [hangupWarning, setHangupWarning] = useState<string | null>(null)

  // Reset-on-change, adjusted during render rather than in an effect (React's
  // documented pattern for exactly this): the moment a new call leaves 'idle',
  // any notice explaining why the PREVIOUS one ended stops being true.
  const [noticeStatus, setNoticeStatus] = useState(status)
  if (status !== noticeStatus) {
    setNoticeStatus(status)
    if (status !== 'idle') {
      if (autoStopNotice !== null) setAutoStopNotice(null)
      if (hangupWarning !== null) setHangupWarning(null)
    }
  }

  const armIdleStop = useCallback(() => {
    idleWatcherRef.current.arm(performance.now())
  }, [])

  // A new call starts from an empty checklist.
  useEffect(() => {
    if (status !== 'idle') return
    checklistRef.current.reset()
    scoredSegmentCountRef.current = 0
    // The rendered checklist has to follow the instance it mirrors; leaving it
    // stale would show the previous call's ticks against the next call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChecklist(emptyChecklistState())
  }, [status])

  // The one moment the checklist speaks: the rep is hanging up, and there is
  // still time to ask. Captured BEFORE stop() runs, because stop() resets the
  // transcript state the checklist was built from.
  const stopWithChecklist = useCallback(() => {
    setHangupWarning(preHangupWarning(checklistRef.current.state()))
    void stop()
  }, [stop])

  // Any transcribed words mean the conversation is still alive.
  useEffect(() => {
    if (segments.length > 0 || interimText) {
      idleWatcherRef.current.noteSpeech(performance.now())
    }
  }, [segments, interimText])

  // Score the newest words against the checklist. Only the tail is scored:
  // coverage is sticky and observe() is idempotent, so re-reading the whole
  // transcript on every update would burn work to reach the same answer.
  //
  // "The tail" means every segment appended since the last time this ran,
  // not just segments.at(-1) — groupWords can append MORE than one new
  // segment in a single finalized-transcript update (a speaker change
  // falling inside one Deepgram final result), and reading only the last
  // one silently dropped whichever earlier segment landed in the same
  // batch. A budget number mentioned right before a mid-result speaker
  // switch would never reach the checklist, and preHangupWarning would
  // wrongly claim it was never asked.
  useEffect(() => {
    const scoredCount = scoredSegmentCountRef.current
    const newSegments = segments.length > scoredCount ? segments.slice(scoredCount) : []
    scoredSegmentCountRef.current = segments.length
    const tail = `${newSegments.map((s) => s.text).join(' ')} ${interimText}`.trim()
    if (!tail) return
    if (checklistRef.current.observe(tail).length > 0) {
      setChecklist(checklistRef.current.state())
    }
  }, [segments, interimText])

  useEffect(() => {
    // 'attaching' included: the auto-stop clock must not run against a call we
    // have not been told the shape of yet.
    if (status === 'idle' || status === 'error' || status === 'attaching') {
      idleWatcherRef.current.disarm()
      return
    }
    const timer = setInterval(() => {
      const decision = idleWatcherRef.current.evaluate(performance.now())
      if (!decision.stop) return
      idleWatcherRef.current.disarm()
      setAutoStopNotice(idleStopNotice(decision.idleMs))
      void stop() // stop() arms the save, so the call is persisted on close
    }, 15_000)
    return () => clearInterval(timer)
  }, [status, stop])

  // Shared guard: two auto-start sources must never start the same call twice.
  //
  // It is CLEARED whenever a call ends, and that matters more than it looks.
  // While this ref latched true for the lifetime of the view, only the first
  // auto-start ever worked: every later detected call hit the guard and was
  // silently dropped — the banner's "Start transcribing" button did nothing,
  // and ambient auto-start reported a failure it could not explain. With
  // auto-start-on-open enabled it was worse still, because that burned the
  // flag at launch and killed every detection for the rest of the session.
  const autoStartedRef = useRef(false)
  useEffect(() => {
    // start() leaves 'idle' before this can re-run, so clearing here cannot
    // race a start that is already in flight.
    if (status === 'idle') autoStartedRef.current = false
  }, [status])

  // Auto-start listening (Settings → AI Note Taker), so the rep needn't click
  // Start. This one genuinely IS once-per-mount — it means "start when the app
  // opens", not "start after every call" — so it keeps its own latch that the
  // reset above deliberately does not touch.
  const [autoStartListening] = useAutoStartListening()
  const appOpenAutoStartedRef = useRef(false)
  useEffect(() => {
    if (!autoStartListening || status !== 'idle') return
    if (appOpenAutoStartedRef.current || autoStartedRef.current) return
    appOpenAutoStartedRef.current = true
    autoStartedRef.current = true
    armIdleStop()
    void (async () => {
      // Exclusion checks the app the rep was using BEFORE switching here —
      // the frontmost app right now is always this app itself (the user just
      // clicked into it), which made the excluded list match nothing. Still
      // best-effort: any detection failure fails OPEN — auto-start proceeds
      // rather than silently never starting.
      const previousApp = await window.api.app.getLastExternalApp().catch(() => null)
      if (previousApp) addSeenApp(previousApp)
      if (previousApp && getExcludedApps().includes(previousApp)) return
      start()
    })()
  }, [autoStartListening, status, start, armIdleStop])

  // Detected-call auto-start (banner click, or the Auto-transcribe setting) —
  // shares autoStartedRef with the effect above so whichever fires first wins
  // and the other never double-starts.
  useEffect(() => {
    if (!autoStartFromDetection) return
    // A request that arrives mid-call is genuinely not actionable, but one that
    // arrives while we are still tearing down the previous call is — so leave
    // the request standing rather than consuming it, and let the effect re-run
    // once status settles back to idle.
    if (autoStartedRef.current) return
    if (status !== 'idle') return
    autoStartedRef.current = true
    armIdleStop()
    onAutoStartFromDetectionConsumed?.()
    start()
  }, [autoStartFromDetection, onAutoStartFromDetectionConsumed, status, start, armIdleStop])

  // Ambient call detection (M15) auto-start — same shared autoStartedRef, so
  // this can never double-start alongside either source above. Unlike those,
  // main process (detection-service.ts) is waiting on an ack: it can't tell
  // on its own whether getUserMedia actually succeeded here, so we report
  // back explicitly via onAmbientAutoStartResult.
  useEffect(() => {
    if (!ambientAutoStart) return
    const { callId } = ambientAutoStart
    onAmbientAutoStartConsumed?.()
    if (status !== 'idle' || autoStartedRef.current) {
      onAmbientAutoStartResult?.({ callId, ok: false })
      return
    }
    autoStartedRef.current = true
    armIdleStop()
    void (async () => {
      await start()
      const sessionId = getSessionId()
      onAmbientAutoStartResult?.(
        sessionId != null ? { callId, ok: true, sessionId } : { callId, ok: false }
      )
    })()
  }, [
    ambientAutoStart,
    onAmbientAutoStartConsumed,
    onAmbientAutoStartResult,
    status,
    start,
    getSessionId,
    armIdleStop
  ])

  // Ambient-detection overlay banner's Stop/Pause buttons live in a different
  // (always-on-top) window, so they can't call stop()/togglePause() directly -
  // main process rebroadcasts each click as an incrementing token here.
  const lastStopToken = useRef(remoteStopToken)
  useEffect(() => {
    if (remoteStopToken === lastStopToken.current) return
    lastStopToken.current = remoteStopToken
    if (status !== 'idle') void stop()
  }, [remoteStopToken, status, stop])

  const lastPauseToken = useRef(remotePauseToken)
  useEffect(() => {
    if (remotePauseToken === lastPauseToken.current) return
    lastPauseToken.current = remotePauseToken
    if (status === 'listening' || status === 'paused' || status === 'reconnecting') togglePause()
  }, [remotePauseToken, status, togglePause])

  // "They said yes": record consent, then — still inside the click gesture —
  // open buyer capture (getDisplayMedia requires a user gesture).
  const handleEnableOtherParty = (method: ConsentMethod): void => {
    consent.markConsented(method)
    // Persist BEFORE arming. Main reads the consent back from disk at both the
    // arm and the grant and refuses without it, so this is not bookkeeping —
    // it is the step that makes capture possible at all. Synchronous, so the
    // click's user activation survives into getDisplayMedia. M27 E1 — keyed
    // on callId, not sessionId (see main/consent-gate.ts's own doc comment).
    //
    // 1.2.6 hotfix (privacy) — same as the auto path above: no arming on a
    // consent that was not stored. Silent, deliberately: the rep just told us
    // to enable capture, and the honest outcome of a refused consent is that
    // capture does not start, which the existing error surface already
    // reports. Arming anyway is what made a stale grant reachable.
    if (!window.api.consent.persist(getCallId() ?? '', consent.recordRef.current)) return
    void enableOtherParty()
  }

  const hasTranscript = segments.length > 0

  // Full-screen states — only when there's no transcript worth preserving.
  if (!hasTranscript) {
    // M26 4.3 — BEFORE the idle branch, and before the fall-through into the
    // in-call layout. Without this, "attaching" with no transcript yet renders
    // the full in-call chrome, complete with a Start button and a "Stopped"
    // badge, during a call that is running perfectly well.
    if (status === 'attaching') return <AttachingState />
    if (status === 'idle') {
      return (
        <>
          <IdleHero
            onStart={start}
            banner={
              currentMeeting ? (
                <InlineBanner tone="positive">
                  <span className="flex min-w-0 items-center gap-2 text-left">
                    <Sparkles className="h-4 w-4 shrink-0" />
                    <span className="truncate">Meeting now: {currentMeeting.title}</span>
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setPrepBriefMeeting({
                        eventId: currentMeeting.id,
                        title: currentMeeting.title,
                        startIso: currentMeeting.start,
                        attendees: currentMeeting.attendees ?? [],
                        contactId: currentMeeting.contactId,
                        dealId: currentMeeting.dealId
                      })
                    }
                  >
                    View prep brief
                  </Button>
                </InlineBanner>
              ) : undefined
            }
          />
          {prepBriefMeeting && (
            <PrepBriefModal meeting={prepBriefMeeting} onClose={() => setPrepBriefMeeting(null)} />
          )}
        </>
      )
    }
    if (status === 'requesting') {
      // Only names the microphone prompt when one is genuinely up. Otherwise
      // this is just "startup is taking a moment", and claiming a prompt the
      // rep cannot see would send them hunting for it.
      return (
        <CenteredState
          icon={<Loader2 className="h-6 w-6 animate-spin text-accent" />}
          title={micPrompting ? 'Requesting microphone access…' : 'Starting…'}
          subtitle={
            micPrompting ? 'Approve the prompt to begin.' : 'Getting your microphone ready.'
          }
        />
      )
    }
    if (status === 'denied') return <DeniedState onRetry={start} />
    if (status === 'no-device') {
      return (
        <CenteredState
          icon={<MicOff className="h-6 w-6 text-faint" />}
          title={MIC_OUTCOME_TEXT['no-device'].title}
          subtitle="Connect a microphone, then try again."
          action={{ label: 'Try again', onClick: start }}
        />
      )
    }
    if (status === 'no-key') return <NoKeyState onRetry={start} />
    if (status === 'error') {
      return (
        <CenteredState
          icon={<AlertTriangle className="h-6 w-6 text-danger" />}
          title="Something went wrong"
          subtitle={errorMessage ?? 'Please try again.'}
          action={{ label: 'Try again', onClick: start }}
        />
      )
    }
  }

  const stoppable =
    status === 'listening' ||
    status === 'paused' ||
    status === 'reconnecting' ||
    status === 'connecting'

  const recording = status === 'listening' || status === 'connecting' || status === 'reconnecting'

  return (
    <div className="relative flex h-full flex-col gap-4">
      {/* Persistent, honest recording state — "you + the other party" only when
          buyer audio is actually streaming. */}
      <RecordingIndicator
        recording={recording}
        paused={status === 'paused'}
        otherPartyConsented={consent.canRecord}
        otherPartyCaptureLive={otherPartyLive}
      />

      {/* Control bar */}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-line-soft bg-surface px-5 py-4">
        {stoppable ? (
          <button
            type="button"
            onClick={stopWithChecklist}
            className="no-drag flex items-center gap-2 rounded-xl bg-danger-soft px-4 py-2.5 text-sm font-semibold text-danger ring-1 ring-inset ring-danger/30 transition hover:bg-danger/20"
          >
            <Square className="h-4 w-4 fill-current" /> Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            className="no-drag flex items-center gap-2 rounded-xl bg-accent-fill px-4 py-2.5 text-sm font-semibold text-on-accent shadow-sm transition hover:brightness-110 active:scale-95"
          >
            <Mic className="h-4 w-4" /> Start
          </button>
        )}

        {/* M34 3d — one line, two glances: stage · risk · last call. Records
            only, present only on a matched-meeting call, absent otherwise
            (no placeholder). Rendered in EVERY mode including Quiet: it is a
            fixed fact, not an instrument, and it never changes during the
            call. Left of the must-ask strip so the first glance is "where
            this deal stands" and the second is "what is still unasked". */}
        <DealFactsLine facts={dealFacts} />
        {recording && <MustAskStrip state={checklist} />}

        {(status === 'listening' || status === 'paused') && (
          <IconButton
            icon={status === 'paused' ? Play : Pause}
            onClick={togglePause}
            label={status === 'paused' ? 'Resume' : 'Pause'}
            className="no-drag h-9 w-9 border border-line"
          />
        )}

        <div className="min-w-[120px] flex-1">
          <Waveform analyser={analyser} active={status === 'listening'} />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {allowOtherPartyRecording && (
            <OtherPartyControl consent={consent} onOpen={() => setConsentOpen(true)} />
          )}
          {/* M34 3c-A — Quiet sits BESIDE the cues mute, deliberately two
              switches: quiet removes what must be READ (gauge, meter, rail,
              deal-intelligence panel); the mute removes the one deterministic
              interrupt that taps you. Founder's call from a real call: quiet
              keeps the interrupt cue. Health/status is never hidden in any
              mode — a capture failure staying visible is the whole point of
              BUG-177's fix. */}
          <QuietToggle quiet={quiet} onToggle={setQuiet} />
          <CueControls
            enabled={enabled}
            onToggle={setEnabled}
            sensitivity={sensitivity}
            onSensitivity={setSensitivity}
          />
          {!quiet && status === 'listening' && engagementScore !== null && (
            <EngagementGauge score={engagementScore} />
          )}
          {!quiet && status === 'listening' && monologue !== null && monologue.ms > 0 && (
            <MonologueMeter state={monologue} />
          )}
          <StatusBadge status={status} />
          <div className="flex min-w-[70px] items-center gap-1.5 text-[13px]">
            {(status === 'listening' || status === 'paused') &&
              (() => {
                const notice = sessionHealthNotice(health)
                // BUG-177 — this block used to be gated on `latencyMs !== null`,
                // and latencyMs is only ever set when transcript text arrives
                // (useTranscription: `if (text) {`). So an indicator whose whole
                // job is to report 'No audio' and 'Reconnecting…' could not draw
                // on a call that never produced text — it could report health
                // only while healthy. The notice needs `health`, never latency,
                // so it now renders on its own; the millisecond READING still
                // requires a number to show, and falls back to the notice.
                if (!notice && latencyMs === null) return null
                const tone = notice ? 'danger' : (latencyMs as number) < 500 ? 'positive' : 'warning'
                return (
                  <>
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        tone === 'danger'
                          ? 'bg-danger'
                          : tone === 'positive'
                            ? 'bg-positive'
                            : 'bg-warning'
                      )}
                    />
                    <span
                      title={notice?.title}
                      className={cn(
                        'font-medium tabular-nums',
                        tone === 'danger'
                          ? 'text-danger'
                          : tone === 'positive'
                            ? 'text-positive'
                            : 'text-warning'
                      )}
                    >
                      {notice ? notice.label : `${latencyMs} ms`}
                    </span>
                  </>
                )
              })()}
          </div>
        </div>
      </div>

      {/* BUG-176 — near-total capture loss, said DURING the call.
        *
        * Deliberately NOT folded into the small health indicator above: that
        * indicator is gated on `latencyMs !== null`, and latencyMs is only ever
        * set when transcript text arrives (useTranscription: `if (text) {`).
        * So the one readout that could report 'nothing is arriving' is hidden
        * exactly when nothing arrives. A banner, on its own gate. */}
      {status === 'listening' &&
        (() => {
          const low = lowCaptureNotice({ health, segments })
          if (!low) return null
          return (
            <InlineBanner tone="warning">
              <span>{low.title}</span>
            </InlineBanner>
          )
        })()}
      {/* Inline banners — keep the transcript visible underneath. */}
      {otherPartyError && (
        <InlineBanner tone={otherPartyError === 'interrupted' ? 'warning' : 'danger'}>
          <span>
            {otherPartyError === 'denied'
              ? isMac
                ? "Couldn't record the other party — macOS blocked screen & system-audio recording."
                : "Couldn't record the other party — screen & system-audio recording was blocked."
              : otherPartyError === 'no-audio'
                ? "Couldn't record the other party — no system audio came through."
                : otherPartyError === 'not-ready'
                  ? // BUG-172 — said DURING the call, not discovered in the
                    // transcript afterwards. This is the whole point of the
                    // state: the app promised to record both sides and could
                    // not, and a rep who knows can still act on it.
                    'Only your side is being recorded — the other party could not be captured for this call. Press Try again to attach it.'
                  : 'The other party’s audio stopped — continuing with your mic only.'}
          </span>
          <span className="flex shrink-0 gap-2">
            {otherPartyError === 'denied' && isMac && (
              <Button
                variant="danger"
                size="sm"
                className="no-drag"
                onClick={() => void window.api.loopback.openScreenSettings()}
              >
                Open Settings
              </Button>
            )}
            <button
              type="button"
              onClick={() => {
                // 1.2.6 hotfix (privacy) — the retry button used to call
                // enableOtherParty() with no consent step at all, so it
                // armed purely on whatever grant happened to be on disk.
                // It now re-persists for the CURRENT call first and refuses
                // to arm if that fails, exactly like the other two paths.
                // MERGE NOTE: arrived from the 1.2.6 hotfix with NO conflict,
                // because 1.3.0 never touched this line — so it kept the old
                // sessionId key while the two paths above moved to callId.
                // Re-keyed by hand. A clean merge is not a correct one.
                if (!window.api.consent.persist(getCallId() ?? '', consent.recordRef.current)) {
                  return
                }
                void enableOtherParty()
              }}
              className={cn(
                'no-drag rounded-lg px-3 py-1.5 text-xs font-semibold',
                otherPartyError === 'interrupted'
                  ? 'bg-warning-soft text-warning hover:bg-warning/20'
                  : 'bg-danger-soft text-danger hover:bg-danger/20'
              )}
            >
              {otherPartyError === 'interrupted' ? 'Resume' : 'Try again'}
            </button>
          </span>
        </InlineBanner>
      )}
      {buyerSilentWarning && (
        <InlineBanner tone="warning">
          <span>
            {isWindows
              ? "The other party's audio looks silent while yours is coming through — Windows " +
                'may be playing the call to a different device than the one we record. Try ' +
                'setting your headset as both Default Device and Default Communication Device.'
              : "The other party's audio has been silent for a while — check that your call app " +
                'is actually routed through the device being captured.'}
          </span>
          <span className="flex shrink-0 gap-2">
            {isWindows && (
              <button
                type="button"
                onClick={() => void window.api.loopback.openWindowsSoundSettings()}
                className="no-drag rounded-lg bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/20"
              >
                Open Sound Settings
              </button>
            )}
            <button
              type="button"
              onClick={dismissBuyerSilentWarning}
              className="no-drag rounded-lg bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/20"
            >
              Dismiss
            </button>
          </span>
        </InlineBanner>
      )}
      {crossTalkWarning && (
        <InlineBanner tone="warning">
          <span>
            Some words may be attributed to the wrong speaker — this usually happens on speakers
            (not headphones), where the other party&rsquo;s voice comes through your mic too.
            Headphones fix this.
          </span>
          <span className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={dismissCrossTalkWarning}
              className="no-drag rounded-lg bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/20"
            >
              Dismiss
            </button>
          </span>
        </InlineBanner>
      )}
      {multichannelFallbackNotice && (
        <InlineBanner tone="warning">
          <span>
            Buyer-side capture couldn&rsquo;t keep up in real time on this connection, so it&rsquo;s
            been turned off for the rest of this call — your side is still being transcribed
            normally. This can happen on a slow or congested connection.
          </span>
          <span className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={dismissMultichannelFallbackNotice}
              className="no-drag rounded-lg bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/20"
            >
              Dismiss
            </button>
          </span>
        </InlineBanner>
      )}
      {coachingPaused && (
        <InlineBanner tone="warning">
          <span>
            {coachingPausedReason === 'timed-out' ? (
              // BUG-057 Phase 2 — a HARD_CEILING_MS timeout is a live,
              // responding provider that was just too slow, genuinely
              // different from every model being unreachable/rate-limited.
              // Before this it wasn't even distinguishable from "not paused"
              // at all (see useLiveCues.ts's own comment on the strict-
              // equality bug this closes).
              <>AI coaching cues are temporarily unavailable (the model is taking too long to respond
                right now) — transcription is unaffected. Resumes automatically.</>
            ) : coachingPausedReason === 'quota-exhausted' ? (
              // BUG-058 Phase 3 — a genuine free-tier quota exhaustion is a
              // different condition from an ordinary rate limit: no amount
              // of waiting a few seconds fixes it, so this says so honestly
              // instead of implying it'll clear itself shortly.
              <>AI coaching cues are temporarily unavailable (a configured model&rsquo;s free-tier
                quota is used up) — transcription is unaffected. Add another provider&rsquo;s key in
                Settings, or wait for it to reset.</>
            ) : (
              <>AI coaching cues are temporarily unavailable (every configured model is unreachable or
                rate-limited right now) — transcription is unaffected. Resumes automatically.</>
            )}
          </span>
        </InlineBanner>
      )}
      {/* Proactive (device-label heuristic) — suppressed once the reactive
          crossTalkWarning above actually confirms misattribution, since that
          banner is strictly more specific and showing both would be noise. */}
      {speakerModeWarning && !crossTalkWarning && (
        <InlineBanner tone="warning">
          <span>
            You appear to be on speakers, not headphones — the other party&rsquo;s voice can leak
            into your mic and get misattributed to you. Headphones make attribution reliable.
          </span>
          <span className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setSpeakerModeWarning(false)}
              className="no-drag rounded-lg bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/20"
            >
              Dismiss
            </button>
          </span>
        </InlineBanner>
      )}
      {status === 'idle' && savedNotice && (
        <InlineBanner tone="positive">
          {/* When the app ended the call itself, say so — a call that stops on
              its own with no explanation reads as a crash. */}
          <span>
            {autoStopNotice ?? 'Call saved to Past Calls.'}
            {/* The clipboard changed under the rep without them asking, so it
                has to be said out loud — an unannounced clipboard write is
                indistinguishable from losing whatever they had copied. */}
            {briefCopied && ' Brief + follow-up email copied to your clipboard.'}
            {hangupWarning && <span className="block text-warning">{hangupWarning}</span>}
          </span>
        </InlineBanner>
      )}
      {status === 'reconnecting' && (
        <InlineBanner tone="warning">
          <span>Reconnecting to the transcription service…</span>
        </InlineBanner>
      )}
      {status === 'error' && (
        <InlineBanner tone="danger">
          <span>{errorMessage ?? 'Something went wrong.'}</span>
          <Button variant="danger" size="sm" className="no-drag shrink-0" onClick={start}>
            Try again
          </Button>
        </InlineBanner>
      )}
      {status === 'no-key' && (
        <InlineBanner tone="danger">
          <span>Add your Deepgram API key to the .env file, then retry.</span>
          <Button variant="danger" size="sm" className="no-drag shrink-0" onClick={start}>
            Try again
          </Button>
        </InlineBanner>
      )}
      {status === 'denied' && (
        <InlineBanner tone="warning">
          <span>Microphone access is off.</span>
          <span className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void window.api.transcription.openMicSettings()}
              className="no-drag rounded-lg bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/20"
            >
              Open Settings
            </button>
            <button
              type="button"
              onClick={start}
              className="no-drag rounded-lg bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/20"
            >
              Try again
            </button>
          </span>
        </InlineBanner>
      )}
      {status === 'no-device' && (
        <InlineBanner tone="warning">
          <span>Microphone disconnected.</span>
          <button
            type="button"
            onClick={start}
            className="no-drag shrink-0 rounded-lg bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning hover:bg-warning/20"
          >
            Reconnect
          </button>
        </InlineBanner>
      )}
      {/* BUG-152 — THE WAY OUT.
          LiveView gates every full-screen state behind `if (!hasTranscript)`,
          so once a call has produced a transcript there is no route back to
          the start screen. Pressing Stop is fine — that saves and navigates
          away — but a call that ends on its own (the watchdog's onCaptureLost
          sets 'no-device') leaves this layout up with "Reconnect" as its only
          control, and Reconnect starts a NEW call. The founder's words: "I
          can't get past it."
          Deliberately NOT shown mid-call: a second stop-shaped button next to
          Stop is a way to lose a call in progress. */}
      {shouldOfferPostCallExit(status, segments.length > 0) && (
        <PostCallReasonBanner decision={postCallReason} onDone={() => setPostCallReason(null)} />
      )}
      {shouldOfferPostCallExit(status, segments.length > 0) && (
        <InlineBanner tone="positive">
          <span>This call has ended. Its transcript is saved to Past Calls.</span>
          <button
            type="button"
            onClick={() => {
              setPostCallReason(null)
              dismissFinishedCall()
            }}
            className="no-drag shrink-0 rounded-lg bg-elevated px-3 py-1.5 text-xs font-semibold text-ink hover:bg-surface"
          >
            Done
          </button>
        </InlineBanner>
      )}

      {/* Transcript + the floating cue card (kept above the Ask-coach bar). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TranscriptView
          segments={segments}
          interimText={interimText}
          repSpeaker={repSpeaker}
          paused={status === 'paused'}
          identities={liveIdentities}
          // 12px for the panel's own `top-3` offset, plus 8px so a line never
          // sits flush against its lower edge.
          reservedTopPx={dealPanelHeight > 0 ? dealPanelHeight + 20 : 0}
          // 16px for the rail's own `right-4` offset, plus 8px so a line
          // never sits flush against a cue's edge. 0 whenever no cue is
          // showing, which is most of a call — the transcript gets its full
          // width back the moment the last cue is dismissed or expires.
          reservedRightPx={cueRailWidth > 0 ? cueRailWidth + 24 : 0}
        />
        {/* Two independent channels (§4.3), one column.
            They stay logically independent — a suggestion can never delay,
            replace or suppress an interrupt — but they share a single
            bottom-anchored stack so they cannot COLLIDE. Positioning each
            absolutely and picking offsets that happen not to overlap works
            until a cue wraps to three lines; this cannot overlap at all.
            The interrupt sits lowest, nearest the eye. */}
        {(cue || suggestions.length > 0) && (
          <div
            ref={cueRailRef}
            className="pointer-events-none absolute top-3 right-4 bottom-4 z-40 flex w-64 flex-col items-end justify-end gap-2"
          >
            {/* M34 3c — in Quiet the rail collapses to a count the rep can
                open; the interrupt cue below it is untouched. */}
            <SuggestionRail
              suggestions={suggestions}
              onDismiss={dismissSuggestion}
              collapsed={quiet}
            />
            {cue && <CueCard key={cue.id} cue={cue} onDismiss={dismiss} />}
          </div>
        )}
        {/* M24 — mounted in the OPPOSITE corner from the coaching-cue column
            above so the two floating stacks can never collide, per
            deal-intelligence/ui/DESIGN.md's mounting guidance. Self-gates on
            `enabled` internally too; gating the wrapper here as well avoids
            an empty pointer-events-none node in the DOM when the beta
            feature is off, matching the cue column's own conditional above. */}
        {/* BUG-173 — gated on the CALL, not just the setting. This read
            `{dealIntelligenceEnabled && (…)}` alone, so the panel rendered
            whenever the feature was switched on — including after the call had
            ended, sitting under the "This call has ended" banner still saying
            "Watching" with a live health score. Every other live element here
            checks `status`; this one did not. */}
        {/* M34 3c — hidden in Quiet (the engine keeps running in the
            Provider; only the panel goes). The callback ref sees the unmount
            and resets the reserved height to 0. */}
        {!quiet && dealIntelligenceEnabled && liveSurfaceVisible && (
          <div
            ref={dealPanelRef}
            className="pointer-events-none absolute top-3 left-4 z-40 flex w-80 flex-col items-start"
          >
            <DealIntelligencePanel
              enabled={dealIntelligenceEnabled}
              status={dealIntelligenceStatus}
              nudges={dealIntelligenceNudges}
              onDismiss={dismissDealIntelligenceNudge}
              healthScore={dealIntelligenceHealthScore}
              onFeedback={rateDealIntelligenceNudge}
            />
          </div>
        )}
        {(status === 'listening' || status === 'paused') && hasTranscript && (
          <div className="pointer-events-none absolute top-3 right-3 z-50 flex items-center gap-2">
            {clips.justClipped && (
              <span className="rounded-lg bg-accent-soft px-2 py-1 text-xs font-medium text-accent">
                Clipped
              </span>
            )}
            <IconButton
              icon={Bookmark}
              label="Clip this moment"
              onClick={handleClip}
              className="no-drag pointer-events-auto border border-line-soft bg-surface/90 backdrop-blur"
            />
          </div>
        )}
      </div>

      <AskCoach segments={segments} interimText={interimText} getCallId={getCallId} />

      {consentOpen && allowOtherPartyRecording && (
        <ConsentModal
          consent={consent}
          onEnable={handleEnableOtherParty}
          onClose={() => setConsentOpen(false)}
        />
      )}
    </div>
  )
}
