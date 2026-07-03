import { useState } from 'react'
import { Award, Wrench, Lightbulb, Target, Quote, ListPlus, Check, Sparkles } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { CoachingReport, CoachDimension, CoachEvidence } from './types'
import {
  DIMENSION_ORDER,
  DIMENSION_LABEL,
  scoreTone,
  overallTier,
  speakerLabel,
  metricRows,
  TONE_TEXT,
  TONE_BAR
} from './meta'

interface CoachReportViewProps {
  report: CoachingReport
  callId: string
  callTitle: string
}

export function CoachReportView({
  report,
  callId,
  callTitle
}: CoachReportViewProps): React.JSX.Element {
  const tier = overallTier(report.overallScore)
  const repSpeaker = report.metrics.repSpeaker
  const dims = DIMENSION_ORDER.map((k) => report.dimensions.find((d) => d.key === k)).filter(
    (d): d is CoachDimension => Boolean(d)
  )

  return (
    <div className="space-y-4">
      {/* Overall + deal context */}
      <div className="flex items-center gap-4 rounded-2xl border border-line-soft bg-canvas p-5">
        <div className="flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-xl bg-elevated">
          <span className={cn('text-2xl font-bold tabular-nums', TONE_TEXT[tier.tone])}>
            {report.overallScore}
          </span>
          <span className="text-[9px] uppercase tracking-wide text-faint">/ 100</span>
        </div>
        <div className="min-w-0">
          <p className={cn('text-sm font-semibold', TONE_TEXT[tier.tone])}>{tier.label} call</p>
          {report.dealContext.summary && (
            <p className="mt-0.5 text-[13px] text-muted">{report.dealContext.summary}</p>
          )}
          {report.dealContext.lens && (
            <p className="mt-1 text-[11px] text-faint">Lens: {report.dealContext.lens}</p>
          )}
        </div>
      </div>

      {/* Deterministic metrics */}
      <div className="flex flex-wrap gap-2">
        {metricRows(report.metrics).map((m) => (
          <div
            key={m.label}
            className="min-w-[7rem] flex-1 rounded-xl border border-line-soft bg-canvas px-3 py-2"
          >
            <p className="text-[10px] uppercase tracking-wide text-faint">{m.label}</p>
            <p className={cn('text-sm font-semibold tabular-nums', TONE_TEXT[m.tone])}>{m.value}</p>
            <p className="text-[10px] text-faint">{m.hint}</p>
          </div>
        ))}
      </div>

      {/* Lead strength */}
      {report.strength.text && (
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
          <div className="flex items-center gap-2 text-emerald-300">
            <Award className="h-4 w-4" />
            <h4 className="text-xs font-semibold uppercase tracking-wide">What worked</h4>
          </div>
          <p className="mt-2 text-sm text-ink">{report.strength.text}</p>
          {report.strength.evidence && (
            <Evidence ev={report.strength.evidence} repSpeaker={repSpeaker} />
          )}
        </div>
      )}

      {/* Top-2 improvements */}
      {report.improvements.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {report.improvements.map((imp, i) => (
            <div key={i} className="rounded-2xl border border-line-soft bg-canvas p-4">
              <div className="flex items-center gap-2 text-accent">
                {imp.kind === 'mechanical' ? (
                  <Wrench className="h-4 w-4" />
                ) : (
                  <Lightbulb className="h-4 w-4" />
                )}
                <h4 className="text-xs font-semibold uppercase tracking-wide">
                  {imp.kind === 'mechanical' ? 'Quick fix' : 'Strategic'}
                </h4>
              </div>
              <p className="mt-2 text-sm font-medium text-ink">{imp.title}</p>
              {imp.detail && <p className="mt-1 text-[13px] text-muted">{imp.detail}</p>}
              {imp.evidence && <Evidence ev={imp.evidence} repSpeaker={repSpeaker} />}
            </div>
          ))}
        </div>
      )}

      {/* Scorecard */}
      <div className="rounded-2xl border border-line-soft bg-canvas p-5">
        <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Scorecard</h4>
        <div className="space-y-4">
          {dims.map((d) => (
            <div key={d.key}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">{DIMENSION_LABEL[d.key]}</span>
                <ScoreBar score={d.score} />
              </div>
              {d.comment && <p className="mt-1 text-[13px] text-muted">{d.comment}</p>}
              {d.evidence && <Evidence ev={d.evidence} repSpeaker={repSpeaker} />}
            </div>
          ))}
        </div>
      </div>

      {/* Next-call action */}
      {report.nextAction && (
        <NextAction nextAction={report.nextAction} callId={callId} callTitle={callTitle} />
      )}

      <p className="text-[11px] text-faint">
        Coached by {report.model} · {new Date(report.createdAt).toLocaleString()}
      </p>
    </div>
  )
}

function Evidence({
  ev,
  repSpeaker
}: {
  ev: CoachEvidence
  repSpeaker: number | null
}): React.JSX.Element {
  return (
    <div className="mt-2 flex gap-2 rounded-lg border-l-2 border-line bg-surface px-3 py-2">
      <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
      <p className="text-[13px] italic leading-relaxed text-muted">
        &ldquo;{ev.quote}&rdquo;{' '}
        <span className="text-faint not-italic">— {speakerLabel(ev.speaker, repSpeaker)}</span>
      </p>
    </div>
  )
}

function ScoreBar({ score }: { score: number }): React.JSX.Element {
  const tone = scoreTone(score)
  return (
    <div className="flex items-center gap-2">
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <span
            key={n}
            className={cn('h-1.5 w-4 rounded-full', n <= score ? TONE_BAR[tone] : 'bg-line')}
          />
        ))}
      </div>
      <span className={cn('text-xs font-semibold tabular-nums', TONE_TEXT[tone])}>{score}/5</span>
    </div>
  )
}

function NextAction({
  nextAction,
  callId,
  callTitle
}: {
  nextAction: string
  callId: string
  callTitle: string
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await window.api.tasks.create({
        title: nextAction,
        type: 'general',
        priority: 'medium',
        source: 'ai',
        callId,
        callTitle
      })
      setSaved(true)
    } catch {
      setError('Could not save the task. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-2xl border border-accent/20 bg-accent-soft p-4">
      <div className="flex items-center gap-2 text-accent">
        <Target className="h-4 w-4" />
        <h4 className="text-xs font-semibold uppercase tracking-wide">Try this next call</h4>
      </div>
      <p className="mt-2 text-sm text-ink">{nextAction}</p>
      <button
        type="button"
        onClick={save}
        disabled={saving || saved}
        className={cn(
          'mt-3 inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition',
          saved
            ? 'cursor-default bg-emerald-500/15 text-emerald-300'
            : 'border border-line text-muted hover:bg-elevated hover:text-ink disabled:opacity-50'
        )}
      >
        {saved ? (
          <>
            <Check className="h-3.5 w-3.5" /> Saved to Tasks
          </>
        ) : (
          <>
            <ListPlus className="h-3.5 w-3.5" /> {saving ? 'Saving…' : 'Save as task'}
          </>
        )}
      </button>
      {error && <p className="mt-2 text-[13px] text-rose-300">{error}</p>}
    </div>
  )
}

/** Loading skeleton shown while Claude coaches the call. */
export function CoachLoading(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5 text-sm text-muted">
        <Sparkles className="h-4 w-4 animate-pulse text-accent" />
        <span>Coaching this call with Claude — scoring against the rubric…</span>
      </div>
      <div className="h-16 animate-pulse rounded-2xl bg-elevated" />
      <div className="flex gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-12 flex-1 animate-pulse rounded-xl bg-elevated" />
        ))}
      </div>
      <div className="space-y-2.5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-6 animate-pulse rounded bg-elevated" />
        ))}
      </div>
    </div>
  )
}
