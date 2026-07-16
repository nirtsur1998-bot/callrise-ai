import { Mic, Users, ShieldCheck } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import type { ConsentJurisdiction } from '@renderer/features/calls/types'
import type { OnboardingState } from '../useOnboarding'
import { StepHeader } from './StepHeader'

const JURISDICTIONS: { id: ConsentJurisdiction; label: string }[] = [
  { id: 'two-party', label: 'Two-party (safer default)' },
  { id: 'one-party', label: 'One-party' }
]

/** Step 3: the recording capability + default jurisdiction. Adapted from Krisp's
 *  "notify participants" screen, held to this app's consent bar. Can only set the
 *  capability flag + a default — it never arms capture (the main-process gate is
 *  unchanged). */
export function RecordingConsent({ o }: { o: OnboardingState }): React.JSX.Element {
  const choices = [
    {
      both: false,
      icon: Mic,
      title: 'My side only',
      body: 'Records just your microphone. No consent step appears on calls.'
    },
    {
      both: true,
      icon: Users,
      title: 'Both sides (with consent)',
      body: 'Lets the per-call consent step appear. The other party is only ever captured after you confirm they said yes on that call.'
    }
  ]

  return (
    <div>
      <StepHeader
        title="Recording"
        subtitle="What CallRise captures on a call. You can change this any time in Settings."
      />
      <div role="radiogroup" aria-label="Recording mode" className="space-y-2.5">
        {choices.map((c) => {
          const selected = o.recordBothSides === c.both
          const Icon = c.icon
          return (
            <button
              key={c.title}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => o.setRecordBothSides(c.both)}
              className={cn(
                'flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition',
                selected
                  ? 'border-accent bg-accent-soft'
                  : 'border-line-soft bg-canvas hover:border-line'
              )}
            >
              <span
                className={cn(
                  'mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg',
                  selected ? 'bg-accent text-white' : 'bg-elevated text-muted'
                )}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{c.title}</span>
                <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">
                  {c.body}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {o.recordBothSides && (
        <div className="mt-4 rounded-xl border border-line-soft bg-canvas p-3.5">
          <div className="mb-2 flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-positive" />
            <p className="text-[13px] font-medium">Default consent jurisdiction</p>
          </div>
          <p className="mb-2.5 text-[12px] text-muted">
            Pre-fills the per-call consent step — changeable on any individual call.
          </p>
          <SegmentedControl
            options={JURISDICTIONS}
            value={o.jurisdiction}
            onChange={o.setJurisdiction}
          />
        </div>
      )}

      <p className="mt-3 text-[11px] text-faint">
        Consent laws for recording calls vary by location — check what applies where you and the
        other party are before recording them.
      </p>
    </div>
  )
}
