import { Card } from '@renderer/components/Card'
import { cn } from '@renderer/lib/cn'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { useCueSettings } from '@renderer/features/live/useCueSettings'
import { SENSITIVITIES, type Sensitivity } from '@renderer/features/live/useLiveCues'
import { SettingRow } from './SettingRow'

const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High'
}

const SENSITIVITY_OPTIONS = SENSITIVITIES.map((s) => ({ id: s, label: SENSITIVITY_LABEL[s] }))

export function CoachingSection(): React.JSX.Element {
  const { enabled, setEnabled, sensitivity, setSensitivity } = useCueSettings()

  return (
    <Card className="mb-5">
      <SettingRow
        title="Live coaching cues"
        description="Glanceable cues during a call — objections, discovery gaps, buying signals, and a rep-only pace nudge. Turns on automatically once a call starts listening, if enabled here."
        control={
          <ToggleSwitch checked={enabled} onChange={setEnabled} label="Show live coaching cues" />
        }
      />

      <div className={cn('mt-4 border-t border-line-soft pt-4', !enabled && 'opacity-50')}>
        <p className="mb-2 text-[13px] font-medium">Default sensitivity</p>
        <SegmentedControl
          options={SENSITIVITY_OPTIONS}
          value={sensitivity}
          onChange={setSensitivity}
          disabled={!enabled}
        />
        <p className="mt-2 text-[11px] text-faint">
          Low shows cues least often (calmest); High shows them most often.
        </p>
      </div>
    </Card>
  )
}
