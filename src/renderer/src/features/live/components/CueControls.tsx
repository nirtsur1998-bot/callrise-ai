import { Bell, BellOff } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { SENSITIVITIES, type Sensitivity } from '../useLiveCues'

const SENS_LABEL: Record<Sensitivity, string> = { low: 'Low', medium: 'Medium', high: 'High' }

interface CueControlsProps {
  enabled: boolean
  onToggle: (v: boolean) => void
  sensitivity: Sensitivity
  onSensitivity: (s: Sensitivity) => void
}

/** Live-screen control: one-click mute (bell) + Low/Med/High sensitivity. */
export function CueControls({
  enabled,
  onToggle,
  sensitivity,
  onSensitivity
}: CueControlsProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => onToggle(!enabled)}
        title={enabled ? 'Mute coaching cues' : 'Unmute coaching cues'}
        className={cn(
          'no-drag flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
          enabled
            ? 'border-accent/40 bg-accent-soft text-ink'
            : 'border-line text-muted hover:text-ink'
        )}
      >
        {enabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
        {enabled ? 'Cues on' : 'Muted'}
      </button>
      <div
        className={cn(
          'no-drag flex items-center gap-0.5 rounded-lg border border-line p-0.5 transition',
          !enabled && 'pointer-events-none opacity-40'
        )}
      >
        {SENSITIVITIES.map((s) => (
          <button
            key={s}
            type="button"
            disabled={!enabled}
            onClick={() => onSensitivity(s)}
            title={`${SENS_LABEL[s]} sensitivity`}
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px] font-semibold transition',
              sensitivity === s ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink'
            )}
          >
            {SENS_LABEL[s][0]}
          </button>
        ))}
      </div>
    </div>
  )
}
