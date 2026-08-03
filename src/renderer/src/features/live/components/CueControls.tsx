import { Bell, BellOff } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { SENSITIVITIES, type Sensitivity } from '../useLiveCues'

const SENS_LABEL: Record<Sensitivity, string> = { low: 'Low', medium: 'Medium', high: 'High' }
const SENS_OPTIONS = SENSITIVITIES.map((s) => ({ id: s, label: SENS_LABEL[s] }))

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
        aria-pressed={enabled}
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
      <SegmentedControl
        options={SENS_OPTIONS}
        value={sensitivity}
        onChange={onSensitivity}
        disabled={!enabled}
        className={cn('no-drag transition', !enabled && 'pointer-events-none opacity-40')}
      />
    </div>
  )
}
