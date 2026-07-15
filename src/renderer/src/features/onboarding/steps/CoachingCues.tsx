import { cn } from '@renderer/lib/cn'
import { ToggleSwitch } from '@renderer/components/ToggleSwitch'
import type { Sensitivity } from '@renderer/features/live/useLiveCues'
import type { OnboardingState } from '../useOnboarding'
import { StepHeader } from './StepHeader'

const LEVELS: { id: Sensitivity; label: string; hint: string }[] = [
  { id: 'low', label: 'Calm', hint: 'Only the important moments' },
  { id: 'medium', label: 'Balanced', hint: 'A steady stream of nudges' },
  { id: 'high', label: 'Active', hint: 'Surface everything it spots' }
]

/** Step 4: live cue on/off + sensitivity → localStorage (live/useCueSettings.ts). */
export function CoachingCues({ o }: { o: OnboardingState }): React.JSX.Element {
  return (
    <div>
      <StepHeader
        title="Live coaching cues"
        subtitle="Glanceable nudges during a live call — an objection, a discovery opening, a buying signal."
      />

      <div className="flex items-center justify-between rounded-xl border border-line-soft bg-canvas p-3.5">
        <div className="min-w-0 pr-3">
          <p className="text-sm font-medium">Show live cues</p>
          <p className="mt-0.5 text-[12px] text-muted">
            Changeable any time from the Live Calls bar.
          </p>
        </div>
        <ToggleSwitch
          checked={o.cuesEnabled}
          onChange={o.setCuesEnabled}
          label="Show live coaching cues"
        />
      </div>

      <div className={cn('mt-3 transition', !o.cuesEnabled && 'pointer-events-none opacity-40')}>
        <p className="mb-2 text-[13px] font-medium text-muted">How often</p>
        <div className="grid grid-cols-3 gap-2">
          {LEVELS.map((lvl) => {
            const selected = o.sensitivity === lvl.id
            return (
              <button
                key={lvl.id}
                type="button"
                disabled={!o.cuesEnabled}
                onClick={() => o.setSensitivity(lvl.id)}
                className={cn(
                  'rounded-xl border p-3 text-left transition',
                  selected
                    ? 'border-accent bg-accent-soft'
                    : 'border-line-soft bg-canvas hover:border-line'
                )}
              >
                <span className="block text-sm font-medium">{lvl.label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">{lvl.hint}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
