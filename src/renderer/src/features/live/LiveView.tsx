import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, Pause, Play, AlertTriangle, MicOff, Loader2, Bookmark } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { isMac } from '@renderer/lib/platform'
import { IconButton } from '@renderer/components/IconButton'
import { Button } from '@renderer/components/Button'
import type { ConsentMethod } from '@renderer/features/calls/types'
import { useTranscription } from './useTranscription'
import { useLiveCues } from './useLiveCues'
import { useLiveClips } from './useLiveClips'
import { useCueSettings } from './useCueSettings'
import { useConsent } from '@renderer/features/consent/useConsent'
import { useAutoStartListening } from '@renderer/features/settings/useAutoStartListening'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import { getExcludedApps, addSeenApp } from '@renderer/features/settings/prefs'
import { OtherPartyControl } from '@renderer/features/consent/OtherPartyControl'
import { ConsentModal } from '@renderer/features/consent/ConsentModal'
import { RecordingIndicator } from '@renderer/features/consent/RecordingIndicator'
import { Waveform } from './components/Waveform'
import { TranscriptView } from './components/TranscriptView'
import { CueCard } from './components/CueCard'
import { CueControls } from './components/CueControls'
import { AskCoach } from './components/AskCoach'
import { EngagementGauge } from './components/EngagementGauge'
import {
  IdleHero,
  CenteredState,
  DeniedState,
  NoKeyState,
  StatusBadge,
  InlineBanner
} from './components/LiveStates'

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
}

export function LiveView({
  onSaved,
  autoStartFromDetection = false,
  onAutoStartFromDetectionConsumed,
  ambientAutoStart = null,
  onAmbientAutoStartConsumed,
  onAmbientAutoStartResult
}: LiveViewProps): React.JSX.Element {
  // Recording consent for the current call (gates future other-party capture).
  const consent = useConsent()
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

  const {
    status,
    segments,
    interimText,
    latencyMs,
    errorMessage,
    analyser,
    savedNotice,
    otherPartyLive,
    otherPartyError,
    start,
    getSessionId,
    stop,
    togglePause,
    enableOtherParty,
    disableOtherParty
  } = useTranscription(consent.recordRef, consent.reset, handleSaved)

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
  const { cue, dismiss, repSpeaker, engagementScore } = useLiveCues(
    status === 'listening',
    enabled,
    sensitivity,
    otherPartyLive ? 0 : null
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
    if (!canRecordOther) void disableOtherParty()
  }, [canRecordOther, disableOtherParty])

  // Settings master switch: when off, the whole other-party recording feature
  // is unavailable — no control to open the modal, the modal itself never
  // renders, and any capture already running is stopped. This can only ever
  // remove capability (see useAppSettings' safe default + app-settings.ts);
  // the per-call consent checks above are unchanged and still fully apply
  // whenever the switch is on.
  const allowOtherPartyRecording = useAppSettings().settings.allowOtherPartyRecording
  useEffect(() => {
    if (!allowOtherPartyRecording) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- force-close the modal/consent when the master switch flips off mid-session
      setConsentOpen(false)
      consent.turnOff()
      void disableOtherParty()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowOtherPartyRecording, disableOtherParty])

  // Auto-start listening (Settings → AI Note Taker), so the rep needn't click
  // Start. Guarded with a ref so it only ever fires once per mount — start()
  // moves status away from 'idle' on success, so this isn't a retry loop.
  const [autoStartListening] = useAutoStartListening()
  const autoStartedRef = useRef(false)
  useEffect(() => {
    if (!autoStartListening || status !== 'idle' || autoStartedRef.current) return
    autoStartedRef.current = true
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
  }, [autoStartListening, status, start])

  // Detected-call auto-start (banner click, or the Auto-transcribe setting) —
  // shares autoStartedRef with the effect above so whichever fires first wins
  // and the other never double-starts.
  useEffect(() => {
    if (!autoStartFromDetection) return
    onAutoStartFromDetectionConsumed?.()
    if (status !== 'idle' || autoStartedRef.current) return
    autoStartedRef.current = true
    start()
  }, [autoStartFromDetection, onAutoStartFromDetectionConsumed, status, start])

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
    getSessionId
  ])

  // "They said yes": record consent, then — still inside the click gesture —
  // open buyer capture (getDisplayMedia requires a user gesture).
  const handleEnableOtherParty = (method: ConsentMethod): void => {
    consent.markConsented(method)
    void enableOtherParty()
  }

  const hasTranscript = segments.length > 0

  // Full-screen states — only when there's no transcript worth preserving.
  if (!hasTranscript) {
    if (status === 'idle') return <IdleHero onStart={start} />
    if (status === 'requesting') {
      return (
        <CenteredState
          icon={<Loader2 className="h-6 w-6 animate-spin text-accent" />}
          title="Requesting microphone access…"
          subtitle="Approve the prompt to begin."
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
            onClick={stop}
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
          <StatusBadge status={status} />
          <div className="flex min-w-[70px] items-center gap-1.5 text-[13px]">
            {latencyMs !== null && (status === 'listening' || status === 'paused') && (
              <>
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    latencyMs < 500 ? 'bg-positive' : 'bg-warning'
                  )}
                />
                <span
                  className={cn(
                    'font-medium tabular-nums',
                    latencyMs < 500 ? 'text-positive' : 'text-warning'
                  )}
                >
                  {latencyMs} ms
                </span>
              </>
            )}
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
      {status === 'idle' && savedNotice && (
        <InlineBanner tone="positive">
          <span>Call saved to Past Calls.</span>
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
        />
        {cue && <CueCard key={cue.id} cue={cue} onDismiss={dismiss} />}
        {(status === 'listening' || status === 'paused') && hasTranscript && (
          <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2">
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
