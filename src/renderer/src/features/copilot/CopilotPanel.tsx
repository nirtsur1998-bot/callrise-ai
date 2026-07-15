import {
  ChevronsLeft,
  ChevronsRight,
  NotebookText,
  AudioLines,
  Radio,
  Mic,
  Loader2
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { isMac } from '@renderer/lib/platform'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { useAutoStartListening } from '@renderer/features/settings/useAutoStartListening'
import { useVirtualMic } from '@renderer/features/audio/useVirtualMic'
import { useAudioDevices } from '@renderer/features/audio/useAudioDevices'
import { useCueSettings } from '@renderer/features/live/useCueSettings'
import type { Sensitivity } from '@renderer/features/live/useLiveCues'

const SENSITIVITY_LEVELS: { id: Sensitivity; label: string }[] = [
  { id: 'low', label: 'Calm' },
  { id: 'medium', label: 'Balanced' },
  { id: 'high', label: 'Active' }
]

interface CopilotPanelProps {
  collapsed: boolean
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
export function CopilotPanel({
  collapsed,
  onToggleCollapsed
}: CopilotPanelProps): React.JSX.Element {
  const [autoStart, setAutoStart] = useAutoStartListening()
  const cues = useCueSettings()
  const { status: micStatus, busy: micBusy, start: startMic, stop: stopMic } = useVirtualMic()
  const { mics, selectedMicId, chooseMic } = useAudioDevices()

  const noiseCancellationOn = Boolean(micStatus?.helperRunning && micStatus?.denoiseActive)
  const noiseCancellationSetUp = Boolean(micStatus?.driverInstalled && micStatus?.helperAvailable)
  const toggleNoiseCancellation = (): void => {
    if (!noiseCancellationSetUp || micBusy) return
    void (micStatus?.helperRunning ? stopMic() : startMic())
  }

  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center py-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="Expand Voice AI"
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
          {isMac && (
            <RailToggle
              icon={AudioLines}
              active={noiseCancellationOn}
              label="Noise cancellation"
              disabled={!noiseCancellationSetUp || micBusy}
              onClick={toggleNoiseCancellation}
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
      <div className="drag flex h-14 shrink-0 items-center justify-between border-b border-line-soft px-5">
        <span className="text-sm font-medium">Voice AI</span>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="Collapse"
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

        {/* Live coaching cues */}
        <Section icon={Radio} title="Live coaching cues">
          <ToggleRow label="Show live cues" checked={cues.enabled} onChange={cues.setEnabled} />
          <div
            className={cn(
              'mt-3 grid grid-cols-3 gap-1.5',
              !cues.enabled && 'pointer-events-none opacity-40'
            )}
          >
            {SENSITIVITY_LEVELS.map((lvl) => (
              <button
                key={lvl.id}
                type="button"
                disabled={!cues.enabled}
                onClick={() => cues.setSensitivity(lvl.id)}
                className={cn(
                  'rounded-lg border py-1.5 text-[12px] font-medium transition',
                  cues.sensitivity === lvl.id
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line-soft bg-canvas text-muted hover:border-line'
                )}
              >
                {lvl.label}
              </button>
            ))}
          </div>
        </Section>

        {/* Microphone */}
        <Section icon={Mic} title="Microphone">
          <select
            value={selectedMicId}
            onChange={(e) => chooseMic(e.target.value)}
            className="w-full rounded-lg border border-line-soft bg-canvas px-3 py-2 text-[13px] text-ink outline-none transition focus:border-line"
          >
            <option value="">System default</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label}
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
