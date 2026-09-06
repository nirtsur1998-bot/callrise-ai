import {
  ChevronsLeft,
  ChevronsRight,
  NotebookText,
  AudioLines,
  Radio,
  Mic,
  Loader2,
  PhoneCall
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { micSelectorOptions } from '@renderer/features/audio/micOutcome'
import { isMac, isWindows } from '@renderer/lib/platform'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { fieldClass } from '@renderer/components/field'
import { useAutoStartListening } from '@renderer/features/settings/useAutoStartListening'
import { useAutoTranscribeCalls } from '@renderer/features/settings/useAutoTranscribeCalls'
import { useVirtualMic } from '@renderer/features/audio/useVirtualMic'
import { useTier1 } from '@renderer/features/audio/useTier1'
import { useAudioDevices } from '@renderer/features/audio/useAudioDevices'
import { useCueSettings } from '@renderer/features/live/useCueSettings'
import type { Sensitivity } from '@renderer/features/live/useLiveCues'
import { VOICE_AI_FITS_FROM_PX } from './voiceAiFit'
import { useToast } from '@renderer/features/notifications/useToast'

const SENSITIVITY_LEVELS: { id: Sensitivity; label: string }[] = [
  { id: 'low', label: 'Calm' },
  { id: 'medium', label: 'Balanced' },
  { id: 'high', label: 'Active' }
]

interface CopilotPanelProps {
  collapsed: boolean
  /** BUG-171 — collapsed by the WINDOW, not by the user: too narrow to hold the
   *  rail beside a usable centre column. The expand control says so instead of
   *  silently doing nothing. */
  forcedCollapsed?: boolean
  onToggleCollapsed: () => void
}

/**
 * The always-visible right-hand panel — a Krisp-style "Voice AI" control rail
 * collapsible between a slim icon strip and a full panel of toggles. Every
 * control here reads/writes the SAME underlying setting shown elsewhere
 * (Home's Audio sources / Noise cancellation cards, Settings' AI Note Taker,
 * Live Calls' cue sensitivity) — this is a second surface for them, not a
 * duplicate store.
 */
/**
 * BUG-153 — keep this panel's own controls out from under the Windows caption
 * buttons.
 *
 * The Voice AI panel is the RIGHTMOST column, and `titleBarOverlay` has
 * Windows draw minimise/maximise/close into a region at the window's top
 * right — over our chrome, not beside it. The panel's collapse/expand chevron
 * sits at the top right of its own 56px header, which put it 20px from the
 * window edge and squarely underneath those buttons at EVERY window width
 * measured (1536, 1366, 1280, 1100). The founder: "The right sidebar's close
 * button is gone."
 *
 * Measured in the running app rather than assumed: the Window Controls
 * Overlay reports a titlebar area of 1144px in a 1280px window — a 136px
 * caption strip, 40px tall.
 *
 * `env(titlebar-area-width)` is the width Windows leaves US. Everything to
 * the right of it belongs to the OS. The fallback makes this exactly 0 on
 * macOS and Linux, where the variable does not exist.
 */
const CAPTION_SAFE_RIGHT: React.CSSProperties = {
  // + 1.25rem keeps the header's own px-5 gutter. Without it the chevron sits
  // flush against the caption strip with zero gap: correct by measurement
  // (fromRight === captionW) but one rounding error from being back
  // underneath, and visibly cramped against the OS buttons.
  paddingRight: 'calc(100vw - env(titlebar-area-width, 100vw) + 1.25rem)'
}

export function CopilotPanel({
  collapsed,
  forcedCollapsed = false,
  onToggleCollapsed
}: CopilotPanelProps): React.JSX.Element {
  const toast = useToast()
  const [autoStart, setAutoStart] = useAutoStartListening()
  const [autoTranscribeCalls, setAutoTranscribeCalls] = useAutoTranscribeCalls()
  const cues = useCueSettings()
  const { status: micStatus, busy: micBusy, start: startMic, stop: stopMic } = useVirtualMic()
  const { mics, selectedMicId, chooseMic } = useAudioDevices()

  const noiseCancellationOn = Boolean(micStatus?.helperRunning && micStatus?.denoiseActive)
  const noiseCancellationSetUp = Boolean(micStatus?.driverInstalled && micStatus?.helperAvailable)
  const toggleNoiseCancellation = (): void => {
    if (!noiseCancellationSetUp || micBusy) return
    void (micStatus?.helperRunning ? stopMic() : startMic())
  }

  // Windows Tier 1 — same section title, DIFFERENT semantics from the mac
  // toggle above, on purpose: mac's is a live start/stop of a persistent
  // helper; this one writes a preference that recorder.ts reads at the start
  // of the NEXT call (Tier 1 has no standalone process to start or stop
  // outside a call — see useTier1's own doc). The status line keeps that
  // honest instead of implying an instant switch.
  const tier1 = useTier1()

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center py-3">
        {/* BUG-153 — the collapsed rail is only 64px wide and sits hard against
            the window's right edge, so its expand chevron is entirely inside
            the 136px caption strip. Push it down BELOW the 40px overlay rather
            than sideways: there is no horizontal room left in a 64px rail. */}
        <div style={{ height: 'env(titlebar-area-height, 0px)' }} aria-hidden="true" />
        {/* BUG-171 — when the WINDOW folded the rail, the chevron stays a live,
            normal-looking control: a greyed-out one read as broken (founder,
            2026-09-05). Clicking it says what would open the panel instead
            of silently doing nothing. */}
        <button
          type="button"
          onClick={() => {
            if (forcedCollapsed) {
              toast.info(`Widen the window to open Voice AI — it needs ${VOICE_AI_FITS_FROM_PX}px.`)
              return
            }
            onToggleCollapsed()
          }}
          title={forcedCollapsed ? 'Voice AI needs a wider window' : 'Expand Voice AI'}
          aria-label="Expand Voice AI"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink"
        >
          <ChevronsLeft className="h-4 w-4" />
        </button>

        <div className="mt-4 flex flex-col items-center gap-2">
          <RailToggle
            icon={NotebookText}
            active={autoStart}
            label="AI Note Taker"
            onClick={() => setAutoStart(!autoStart)}
          />
          <RailToggle
            icon={PhoneCall}
            active={autoTranscribeCalls}
            label="Auto-transcribe detected calls"
            onClick={() => setAutoTranscribeCalls(!autoTranscribeCalls)}
          />
          {isMac && (
            <RailToggle
              icon={AudioLines}
              active={noiseCancellationOn}
              label="Noise cancellation"
              disabled={!noiseCancellationSetUp || micBusy}
              onClick={toggleNoiseCancellation}
            />
          )}
          {isWindows && (
            <RailToggle
              icon={AudioLines}
              active={tier1.enabled}
              label="Noise cancellation"
              disabled={tier1.uiState === 'unavailable'}
              onClick={() => tier1.setEnabled(!tier1.enabled)}
            />
          )}
          <RailToggle
            icon={Radio}
            active={cues.enabled}
            label="Live coaching cues"
            onClick={() => cues.setEnabled(!cues.enabled)}
          />
          <button
            type="button"
            onClick={onToggleCollapsed}
            title="Choose microphone"
            aria-label="Choose microphone"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink"
          >
            <Mic className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div
        className="drag flex h-14 shrink-0 items-center justify-between border-b border-line-soft px-5"
        style={CAPTION_SAFE_RIGHT}
      >
        <span className="text-sm font-medium">Voice AI</span>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="Collapse"
          aria-label="Collapse Voice AI panel"
          className="no-drag grid h-7 w-7 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink"
        >
          <ChevronsRight className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-5 px-5 py-5">
        {/* AI Note Taker */}
        <Section icon={NotebookText} title="AI Note Taker">
          <ToggleRow
            label="Auto-start when you join a call"
            checked={autoStart}
            onChange={setAutoStart}
          />
        </Section>

        {/* Call detection — notices a known calling app (WhatsApp, Zoom,
            Teams, MicroSIP, …) running and offers to transcribe it. */}
        <Section icon={PhoneCall} title="Call detection">
          <ToggleRow
            label="Auto-transcribe detected calls"
            checked={autoTranscribeCalls}
            onChange={setAutoTranscribeCalls}
          />
          <p className="mt-2 text-[12px] text-faint">
            {autoTranscribeCalls
              ? 'Starts transcribing right away when a known calling app is detected.'
              : "You'll get a prompt to confirm before we start transcribing."}
          </p>
        </Section>

        {/* Noise cancellation — macOS only, same guard as the Home card. */}
        {isMac && (
          <Section icon={AudioLines} title="Noise cancellation">
            {noiseCancellationSetUp ? (
              <ToggleRow
                label="Clean my microphone"
                checked={noiseCancellationOn}
                onChange={toggleNoiseCancellation}
                busy={micBusy}
              />
            ) : (
              <p className="text-[12px] text-faint">
                Set up from the Home screen&rsquo;s Noise cancellation card first.
              </p>
            )}
          </Section>
        )}

        {/* Noise cancellation — Windows Tier 1. Reads/writes the SAME
            preference as Settings → Audio's card (this panel's whole contract:
            a second surface, never a duplicate store). */}
        {isWindows && (
          <Section icon={AudioLines} title="Noise cancellation">
            {tier1.uiState === 'unavailable' ? (
              <p className="text-[12px] text-faint">
                The noise-cancellation engine wasn&rsquo;t found on this install.
              </p>
            ) : (
              <>
                <ToggleRow
                  label="Clean my microphone"
                  checked={tier1.enabled}
                  onChange={() => tier1.setEnabled(!tier1.enabled)}
                />
                <p
                  className={cn(
                    'mt-2 text-[12px]',
                    tier1.uiState === 'model-missing' ? 'text-warning' : 'text-faint'
                  )}
                >
                  {tier1.uiState === 'active' && 'On — your voice is being cleaned.'}
                  {tier1.uiState === 'starting' && 'On — takes effect when your next call starts.'}
                  {tier1.uiState === 'model-missing' &&
                    'On, but the model wasn’t found — audio is passing through uncleaned.'}
                  {tier1.uiState === 'off' && 'Cleans your microphone on your next call.'}
                </p>
              </>
            )}
          </Section>
        )}

        {/* Live coaching cues */}
        <Section icon={Radio} title="Live coaching cues">
          <ToggleRow label="Show live cues" checked={cues.enabled} onChange={cues.setEnabled} />
          <SegmentedControl
            options={SENSITIVITY_LEVELS}
            value={cues.sensitivity}
            onChange={cues.setSensitivity}
            disabled={!cues.enabled}
            className="mt-3 w-full"
          />
        </Section>

        {/* Microphone */}
        <Section icon={Mic} title="Microphone">
          <select
            value={selectedMicId}
            onChange={(e) => chooseMic(e.target.value)}
            aria-label="Microphone"
            className={cn(fieldClass, 'text-[13px]')}
          >
            {micSelectorOptions(mics).map((opt) => (
              <option key={opt.value || '__default'} value={opt.value} disabled={opt.disabled}>
                {opt.label}
              </option>
            ))}
          </select>
        </Section>
      </div>
    </div>
  )
}

function Section({
  icon: Icon,
  title,
  children
}: {
  icon: typeof NotebookText
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">
        <Icon className="h-3.5 w-3.5" /> {title}
      </div>
      {children}
    </div>
  )
}

function ToggleRow({
  label,
  checked,
  onChange,
  busy
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  busy?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-line-soft bg-canvas px-3 py-2.5">
      <span className="text-[13px] text-ink">{label}</span>
      {busy ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin text-faint" />
      ) : (
        <ToggleSwitch checked={checked} onChange={onChange} label={label} />
      )}
    </div>
  )
}

function RailToggle({
  icon: Icon,
  active,
  label,
  disabled,
  onClick
}: {
  icon: typeof NotebookText
  active: boolean
  label: string
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-lg transition disabled:opacity-40',
        active ? 'bg-accent-soft text-accent' : 'text-faint hover:bg-elevated hover:text-ink'
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}
