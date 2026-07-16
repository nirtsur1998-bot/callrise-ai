import { fieldClass } from '@renderer/components/field'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import type { OnboardingState } from '../useOnboarding'
import { StepHeader } from './StepHeader'

const PRONOUNS = [
  { id: 'he', label: 'He/him' },
  { id: 'she', label: 'She/her' },
  { id: 'they', label: 'They/them' },
  { id: '', label: 'Skip' }
] as const

const MAX_NAME = 100
const MAX_ROLE = 150

/** Step 1: name / role / pronoun → settings.personalization. */
export function AboutYou({ o }: { o: OnboardingState }): React.JSX.Element {
  return (
    <div>
      <StepHeader
        title="Who you are"
        subtitle="So summaries and coaching read like they understand your role."
      />
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-muted">Your name</label>
          <input
            value={o.name}
            onChange={(e) => o.setName(e.target.value)}
            maxLength={MAX_NAME}
            autoFocus
            placeholder="e.g. Alex Rivera"
            className={fieldClass}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-muted">Your role</label>
          <input
            value={o.role}
            onChange={(e) => o.setRole(e.target.value)}
            maxLength={MAX_ROLE}
            placeholder="e.g. Account Executive at Acme Co"
            className={fieldClass}
          />
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-muted">
            Preferred pronoun for summaries
          </p>
          <SegmentedControl
            options={PRONOUNS.map((opt) => ({ id: opt.id, label: opt.label }))}
            value={o.pronoun}
            onChange={o.setPronoun}
            className="flex-wrap"
          />
        </div>
      </div>
    </div>
  )
}
