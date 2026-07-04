import { useEffect, useState } from 'react'
import { Mic, Square, Pause, Play, AlertTriangle, MicOff, Loader2 } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { ConsentMethod } from '@renderer/features/calls/types'
import { useTranscription } from './useTranscription'
import { useLiveCues } from './useLiveCues'
import { useCueSettings } from './useCueSettings'
import { useConsent } from '@renderer/features/consent/useConsent'
import { OtherPartyControl } from '@renderer/features/consent/OtherPartyControl'
import { ConsentModal } from '@renderer/features/consent/ConsentModal'
import { RecordingIndicator } from '@renderer/features/consent/RecordingIndicator'
import { Waveform } from './components/Waveform'
import { TranscriptView } from './components/TranscriptView'
import { CueCard } from './components/CueCard'
import { CueControls } from './components/CueControls'
import { AskCoach } from './components/AskCoach'
import {
  IdleHero,
  CenteredState,
  DeniedState,
  NoKeyState,
  StatusBadge,
  InlineBanner
} from './components/LiveStates'

export function LiveView(): React.JSX.Element {
  // Recording consent for the current call (gates future other-party capture).
  const consent = useConsent()
  const [consentOpen, setConsentOpen] = useState(false)

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
    stop,
    togglePause,
    enableOtherParty,
    disableOtherParty
  } = useTranscription(consent.recordRef, consent.reset)

  // Live coaching cues (hooks must run before any early return).
  const { enabled, setEnabled, sensitivity, setSensitivity } = useCueSettings()
  // When buyer capture is live, the rep is channel 0 — tell the cues so they
  // don't have to guess who the rep is.
  const { cue, dismiss } = useLiveCues(
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
          icon={<AlertTriangle className="h-6 w-6 text-rose-400" />}
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
      <div className="flex items-center gap-4 rounded-2xl border border-line-soft bg-surface px-5 py-4">
        {stoppable ? (
          <button
            type="button"
            onClick={stop}
            className="no-drag flex items-center gap-2 rounded-xl bg-rose-500/15 px-4 py-2.5 text-sm font-semibold text-rose-300 ring-1 ring-inset ring-rose-500/30 transition hover:bg-rose-500/25"
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
          <button
            type="button"
            onClick={togglePause}
            title={status === 'paused' ? 'Resume' : 'Pause'}
            className="no-drag grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition hover:bg-elevated hover:text-ink"
          >
            {status === 'paused' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
          </button>
        )}

        <div className="min-w-0 flex-1">
          <Waveform analyser={analyser} active={status === 'listening'} />
        </div>

        <div className="flex items-center gap-3">
          <OtherPartyControl consent={consent} onOpen={() => setConsentOpen(true)} />
          <CueControls
            enabled={enabled}
            onToggle={setEnabled}
            sensitivity={sensitivity}
            onSensitivity={setSensitivity}
          />
          {status === 'connecting' && <Loader2 className="h-4 w-4 animate-spin text-muted" />}
          <StatusBadge status={status} />
          {latencyMs !== null && (status === 'listening' || status === 'paused') && (
            <div className="rounded-lg border border-line-soft bg-canvas px-2.5 py-1 text-right">
              <div className="text-[10px] uppercase tracking-wider text-faint">latency</div>
              <div
                className={cn(
                  'text-sm font-semibold tabular-nums',
                  latencyMs < 500 ? 'text-emerald-400' : 'text-amber-400'
                )}
              >
                {latencyMs} ms
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Inline banners — keep the transcript visible underneath. */}
      {otherPartyError && (
        <InlineBanner tone={otherPartyError === 'interrupted' ? 'amber' : 'rose'}>
          <span>
            {otherPartyError === 'denied'
              ? "Couldn't record the other party — macOS blocked screen & system-audio recording."
              : otherPartyError === 'no-audio'
                ? "Couldn't record the other party — no system audio came through."
                : 'The other party’s audio stopped — continuing with your mic only.'}
          </span>
          <span className="flex shrink-0 gap-2">
            {otherPartyError === 'denied' && (
              <button
                type="button"
                onClick={() => void window.api.loopback.openScreenSettings()}
                className="no-drag rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
              >
                Open Settings
              </button>
            )}
            <button
              type="button"
              onClick={() => void enableOtherParty()}
              className={cn(
                'no-drag rounded-lg px-3 py-1.5 text-xs font-semibold',
                otherPartyError === 'interrupted'
                  ? 'bg-amber-500/20 text-amber-100 hover:bg-amber-500/30'
                  : 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
              )}
            >
              {otherPartyError === 'interrupted' ? 'Resume' : 'Try again'}
            </button>
          </span>
        </InlineBanner>
      )}
      {status === 'idle' && savedNotice && (
        <InlineBanner tone="emerald">
          <span>Call saved to Past Calls.</span>
        </InlineBanner>
      )}
      {status === 'reconnecting' && (
        <InlineBanner tone="amber">
          <span>Reconnecting to the transcription service…</span>
        </InlineBanner>
      )}
      {status === 'error' && (
        <InlineBanner tone="rose">
          <span>{errorMessage ?? 'Something went wrong.'}</span>
          <button
            type="button"
            onClick={start}
            className="no-drag shrink-0 rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
          >
            Try again
          </button>
        </InlineBanner>
      )}
      {status === 'no-key' && (
        <InlineBanner tone="rose">
          <span>Add your Deepgram API key to the .env file, then retry.</span>
          <button
            type="button"
            onClick={start}
            className="no-drag shrink-0 rounded-lg bg-rose-500/20 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
          >
            Try again
          </button>
        </InlineBanner>
      )}
      {status === 'denied' && (
        <InlineBanner tone="amber">
          <span>Microphone access is off.</span>
          <span className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void window.api.transcription.openMicSettings()}
              className="no-drag rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/30"
            >
              Open Settings
            </button>
            <button
              type="button"
              onClick={start}
              className="no-drag rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/30"
            >
              Try again
            </button>
          </span>
        </InlineBanner>
      )}
      {status === 'no-device' && (
        <InlineBanner tone="amber">
          <span>Microphone disconnected.</span>
          <button
            type="button"
            onClick={start}
            className="no-drag shrink-0 rounded-lg bg-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/30"
          >
            Reconnect
          </button>
        </InlineBanner>
      )}

      {/* Transcript + the floating cue card (kept above the Ask-coach bar). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TranscriptView segments={segments} interimText={interimText} />
        {cue && <CueCard key={cue.id} cue={cue} onDismiss={dismiss} />}
      </div>

      <AskCoach segments={segments} interimText={interimText} />

      {consentOpen && (
        <ConsentModal
          consent={consent}
          onEnable={handleEnableOtherParty}
          onClose={() => setConsentOpen(false)}
        />
      )}
    </div>
  )
}
