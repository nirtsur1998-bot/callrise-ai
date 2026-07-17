import { useState } from 'react'
import { ShieldAlert, RotateCw, ArrowRight, PhoneCall } from 'lucide-react'
import { Badge, type BadgeTone } from '@renderer/components/Badge'
import { Button } from '@renderer/components/Button'
import { Skeleton } from '@renderer/components/Skeleton'
import { formatRelative } from '@renderer/features/contacts/contactStats'
import type { Deal, DealRiskLevel } from './types'

const LEVEL_TONE: Record<DealRiskLevel, BadgeTone> = {
  low: 'positive',
  medium: 'warning',
  high: 'danger'
}
const LEVEL_LABEL: Record<DealRiskLevel, string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk'
}

interface RiskAssessmentCardProps {
  deal: Deal
  /** Called after a successful (re-)assessment so the parent can refetch the deal. */
  onAssessed: () => void
}

/** Manual, per-deal AI risk assessment (Phase 5 Step 1). Never runs
 *  automatically — the rep taps "Assess risk", and the result is cached on
 *  the deal until they choose to re-run it. */
export function RiskAssessmentCard({
  deal,
  onAssessed
}: RiskAssessmentCardProps): React.JSX.Element {
  const [assessing, setAssessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [noKey, setNoKey] = useState(false)

  const assess = async (): Promise<void> => {
    setError(null)
    setNoKey(false)
    setAssessing(true)
    try {
      const res = await window.api.deals.assessRisk(deal.id)
      if (res.ok) onAssessed()
      else if (res.error === 'no-key') setNoKey(true)
      else setError(res.message ?? 'Could not assess this deal.')
    } catch {
      setError('Could not assess this deal. Please try again.')
    } finally {
      setAssessing(false)
    }
  }

  const assessment = deal.riskAssessment

  return (
    <section className="rounded-2xl border border-line-soft bg-surface p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Risk assessment</h3>
        </div>
        {assessment && !assessing && (
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-faint">
              Assessed {formatRelative(assessment.createdAt)}
            </span>
            <Button variant="secondary" size="sm" icon={RotateCw} onClick={() => void assess()}>
              Re-assess
            </Button>
          </div>
        )}
      </div>

      {noKey && (
        <p className="mb-3 text-[13px] text-warning">
          Add your Anthropic API key in Settings → API keys to use this feature.
        </p>
      )}

      {/* Hoisted above the branch: with a cached assessment, a failed
          Re-assess used to set this and render NOTHING — the old report
          reappeared looking like a silent success with stale data. */}
      {error && !assessing && assessment && <p className="mb-3 text-[13px] text-danger">{error}</p>}

      {assessing ? (
        <RiskLoading />
      ) : assessment ? (
        <RiskReport assessment={assessment} />
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted">
            Get an AI read on whether this deal is likely to stall — grounded only in this
            deal&apos;s own data and its contact&apos;s call history, never guessed.
          </p>
          {error && <p className="text-[13px] text-danger">{error}</p>}
          <Button icon={ShieldAlert} onClick={() => void assess()}>
            Assess risk
          </Button>
        </div>
      )}
    </section>
  )
}

function RiskReport({
  assessment
}: {
  assessment: NonNullable<Deal['riskAssessment']>
}): React.JSX.Element {
  const tone = LEVEL_TONE[assessment.level]
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-xl border border-line-soft bg-canvas p-4">
        <Badge tone={tone} className="shrink-0">
          {LEVEL_LABEL[assessment.level]}
        </Badge>
        <div className="min-w-0">
          <p className="text-[13px] text-muted">{assessment.summary}</p>
        </div>
      </div>

      {assessment.reasons.length > 0 && (
        <ul className="space-y-2">
          {assessment.reasons.map((reason, i) => (
            <li
              key={i}
              className="flex items-start gap-2 rounded-lg border border-line-soft bg-canvas px-3 py-2.5"
            >
              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
              <div className="min-w-0">
                <p className="text-[13px] text-muted">{reason.text}</p>
                {reason.callTitle && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-faint">
                    <PhoneCall className="h-3 w-3" /> {reason.callTitle}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border border-accent/25 bg-accent-soft/40 px-3 py-2.5">
        <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
          Suggested action
        </p>
        <p className="mt-0.5 text-[13px] text-ink">{assessment.suggestedAction}</p>
      </div>
    </div>
  )
}

function RiskLoading(): React.JSX.Element {
  return (
    <div className="space-y-3">
      <Skeleton className="h-14 rounded-xl" />
      <Skeleton className="h-10 rounded-lg" />
      <Skeleton className="h-10 rounded-lg" />
    </div>
  )
}
