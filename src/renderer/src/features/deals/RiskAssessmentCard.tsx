import { useState } from 'react'
import { ShieldAlert, RotateCw, ArrowRight, PhoneCall } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { Tone } from '@renderer/features/coaching/meta'
import { TONE_TEXT, TONE_BAR } from '@renderer/features/coaching/meta'
import type { Deal, DealRiskLevel } from './types'

const LEVEL_TONE: Record<DealRiskLevel, Tone> = { low: 'good', medium: 'mid', high: 'low' }
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
          <button
            type="button"
            onClick={() => void assess()}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
          >
            <RotateCw className="h-3.5 w-3.5" /> Re-assess
          </button>
        )}
      </div>

      {noKey && (
        <p className="mb-3 text-[13px] text-amber-200">
          Add your Anthropic API key (ANTHROPIC_API_KEY in .env) to use this feature.
        </p>
      )}

      {/* Hoisted above the branch: with a cached assessment, a failed
          Re-assess used to set this and render NOTHING — the old report
          reappeared looking like a silent success with stale data. */}
      {error && !assessing && assessment && (
        <p className="mb-3 text-[13px] text-rose-300">{error}</p>
      )}

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
          {error && <p className="text-[13px] text-rose-300">{error}</p>}
          <button
            type="button"
            onClick={() => void assess()}
            className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
          >
            <ShieldAlert className="h-4 w-4" /> Assess risk
          </button>
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
        <div className={cn('h-2.5 w-2.5 shrink-0 rounded-full', TONE_BAR[tone])} />
        <div className="min-w-0">
          <p className={cn('text-sm font-semibold', TONE_TEXT[tone])}>
            {LEVEL_LABEL[assessment.level]}
          </p>
          <p className="mt-0.5 text-[13px] text-muted">{assessment.summary}</p>
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
      <div className="h-14 animate-pulse rounded-xl bg-elevated" />
      <div className="h-10 animate-pulse rounded-lg bg-elevated" />
      <div className="h-10 animate-pulse rounded-lg bg-elevated" />
    </div>
  )
}
