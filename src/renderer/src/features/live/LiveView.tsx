import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { useTranscription } from './useTranscription'
import { useLiveCues } from './useLiveCues'
import { useLiveClips } from './useLiveClips'
import { useCueSettings } from './useCueSettings'
import { useConsent } from '@renderer/features/consent/useConsent'
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
import { CueCard } from './components/CueCard'
import { SuggestionRail } from './components/SuggestionRail'
import { CueControls } from './components/CueControls'
import { AskCoach } from './components/AskCoach'
import { EngagementGauge } from './components/EngagementGauge'
import { MonologueMeter } from './components/MonologueMeter'
import {
  IdleHero,
  CenteredState,
  DeniedState,
  NoKeyState,
  StatusBadge,
  InlineBanner
} from './components/LiveStates'
import { sessionHealthNotice } from './session-health-notice'

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
  // Settings first: standing consent has to be known before useConsent builds
  // the call's opening record, or the first call of a session would start from
  // "not asked" and only correct itself a tick later.
  const appSettings = useAppSettings().settings
  const allowOtherPartyRecording = appSettings.allowOtherPartyRecording
  // Standing consent is gated on the master switch — it can never grant
  // capability the switch has removed.
  const standingConsent = allowOtherPartyRecording && appSettings.alwaysRecordOtherParty

  // Recording consent for the current call (gates other-party capture).
  const consent = useConsent(standingConsent)
  const [consentOpen, setConsentOpen] = useState(false)

  // "Clip this" — a local, in-memory clip buffer (no callId exists yet for a
  // live-in-progress call). Flushed to real bookmarks once the call is saved.
  const clips = useLiveClips()

  // Wrap the parent's onSaved so every clip captured this call is flushed to
  // window.api.calls.addBookmark against the now-real callId, fire-and-forget,
  // before handing off to whatever the parent wants to do with the saved id.
  const handleSaved = useCallback(
    (callId: string) => {
      clips.flush(callId)
      onSaved?.(callId)
    },
    [clips, onSaved]
  )

  // M19 Task 2 step 5 — bridges useLiveCues' self-intro extraction (below,
  // must run AFTER useTranscription per hooks' call-order rules) into
  // useTranscription's save flow. A ref, not a hook argument, since
  // useTranscription only ever READS it later at save time (async), by
  // which point useLiveCues has already written the resolved value.
  const buyerIdentityRef = useRef<{ key: string; name: string } | null>(null)

  const {
    status,
    segments,
    interimText,
    latencyMs,
    health,
    errorMessage,
    analyser,
    savedNotice,
    identifyRep,
    otherPartyLive,
    otherPartyError,
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
    stop,
    togglePause,
    enableOtherParty,
    disableOtherParty
  } = useTranscription(consent.recordRef, consent.reset, handleSaved, buyerIdentityRef)

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
  }, [calEvents, googleEvents, outlookEvents])

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

  // Live coaching cues (hooks must run before any early return).
  const { enabled, setEnabled, sensitivity, setSensitivity } = useCueSettings()
  // When buyer capture is live, the rep is channel 0 — tell the cues so they
  // don't have to guess who the rep is.
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
    coachingPaused
  } = useLiveCues(
    status === 'listening',
    enabled,
    sensitivity,
    otherPartyLive ? 0 : null,
    identifyRep
  )

  // Keep the save-time ref in sync with the live-resolved buyer name, and
  // build the identities map SpeakerTranscript needs to show it DURING the
  // call (not just after saving) — the M19 brief's "propagates to the live
  // transcript" requirement.
  useEffect(() => {
    buyerIdentityRef.current = buyerName && buyerIdentityKey ? { key: buyerIdentityKey, name: buyerName } : null
  }, [buyerName, buyerIdentityKey, buyerIdentityRef])
  const liveIdentities = useMemo(
    () =>
      buyerName && buyerIdentityKey
        ? { [buyerIdentityKey]: { name: buyerName, source: 'self-intro' as const, confidence: 'medium' as const } }
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
  const autoBuyerAttemptedRef = useRef(false)
  useEffect(() => {
    if (status === 'idle') autoBuyerAttemptedRef.current = false
  }, [status])
  useEffect(() => {
    if (autoBuyerAttemptedRef.current) return
    if (status !== 'listening' || !canRecordOther || otherPartyLive || otherPartyError) return
    autoBuyerAttemptedRef.current = true
    // Standing consent still has to be written before capture can be armed —
    // the gate does not care WHERE the consent came from, only that a record
    // for this call exists on disk.
    window.api.consent.persist(getSessionId() ?? -1, consent.recordRef.current)
    void enableOtherParty()
  }, [
    status,
    canRecordOther,
    otherPartyLive,
    otherPartyError,
    enableOtherParty,
    getSessionId,
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
  // Seeded from the module, not from the ref — reading a ref during render is
  // exactly the pattern that makes concurrent rendering tear.
  const [checklist, setChecklist] = useState(emptyChecklistState)

  const idleWatcherRef = useRef(new IdleStopWatcher())
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
  useEffect(() => {
    const tail = `${segments.at(-1)?.text ?? ''} ${interimText}`.trim()
    if (!tail) return
    if (checklistRef.current.observe(tail).length > 0) {
      setChecklist(checklistRef.current.state())
    }
  }, [segments, interimText])

  useEffect(() => {
    if (status === 'idle' || status === 'error') {
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
    // click's user activation survives into getDisplayMedia.
    window.api.consent.persist(getSessionId() ?? -1, consent.recordRef.current)
    void enableOtherParty()
  }

  const hasTranscript = segments.length > 0

  // Full-screen states — only when there's no transcript worth preserving.
  if (!hasTranscript) {
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
          title="No microphone found"
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
            className="no-drag flex items-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-95"
          >
            <Mic className="h-4 w-4" /> Start
          </button>
        )}

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
          <CueControls
            enabled={enabled}
            onToggle={setEnabled}
            sensitivity={sensitivity}
            onSensitivity={setSensitivity}
          />
          {status === 'listening' && engagementScore !== null && (
            <EngagementGauge score={engagementScore} />
          )}
          {status === 'listening' && monologue !== null && monologue.ms > 0 && (
            <MonologueMeter state={monologue} />
          )}
          <StatusBadge status={status} />
          <div className="flex min-w-[70px] items-center gap-1.5 text-[13px]">
            {latencyMs !== null &&
              (status === 'listening' || status === 'paused') &&
              (() => {
                const notice = sessionHealthNotice(health)
                const tone = notice ? 'danger' : latencyMs < 500 ? 'positive' : 'warning'
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
              onClick={() => void enableOtherParty()}
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
            AI coaching cues are temporarily unavailable (every configured model is unreachable or
            rate-limited right now) — transcription is unaffected. Resumes automatically.
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

      {/* Transcript + the floating cue card (kept above the Ask-coach bar). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TranscriptView
          segments={segments}
          interimText={interimText}
          repSpeaker={repSpeaker}
          paused={status === 'paused'}
          identities={liveIdentities}
        />
        {/* Two independent channels (§4.3), one column.
            They stay logically independent — a suggestion can never delay,
            replace or suppress an interrupt — but they share a single
            bottom-anchored stack so they cannot COLLIDE. Positioning each
            absolutely and picking offsets that happen not to overlap works
            until a cue wraps to three lines; this cannot overlap at all.
            The interrupt sits lowest, nearest the eye. */}
        {(cue || suggestions.length > 0) && (
          <div className="pointer-events-none absolute top-3 right-4 bottom-4 z-40 flex w-64 flex-col items-end justify-end gap-2">
            <SuggestionRail suggestions={suggestions} onDismiss={dismissSuggestion} />
            {cue && <CueCard key={cue.id} cue={cue} onDismiss={dismiss} />}
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

      <AskCoach segments={segments} interimText={interimText} />

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
