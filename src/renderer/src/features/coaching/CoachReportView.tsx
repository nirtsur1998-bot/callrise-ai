import { useEffect, useState } from 'react'
import {
  Award,
  Wrench,
  Lightbulb,
  Target,
  Quote,
  ListPlus,
  Check,
  Sparkles,
  Trophy,
  TrendingUp,
  FileDown,
  Loader2
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { ScoreGauge } from '@renderer/components/ScoreGauge'
import { Skeleton } from '@renderer/components/Skeleton'
import { Badge } from '@renderer/components/Badge'
import { Button } from '@renderer/components/Button'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { useToast } from '@renderer/features/notifications/useToast'
import type { CoachingReport, CoachDimension, CoachEvidence } from './types'
import {
  SKILL_LABEL,
  SKILL_KEYS,
  CALL_TYPES,
  CALL_TYPE_LABEL,
  METHODOLOGY_LABEL,
  type CallType
} from './types'
import { useSkillProgress } from './useSkillProgress'
import {
  DIMENSION_ORDER,
  DIMENSION_LABEL,
  scoreTone,
  overallTier,
  speakerLabel,
  metricRows,
  TONE_TEXT,
  TONE_BAR,
  TONE_TO_GAUGE,
  TONE_TO_BADGE,
  type SpeakerIdentities
} from './meta'

/** A4 — "the next call's coaching report LEADS with focus-skill
 *  performance." Reads the skill history the main process already rolled
 *  up (useSkillProgress) to compare THIS call's score on the focus skill
 *  against the call immediately before it — located by callId within the
 *  history, not just "the global second-to-last call" (which would be
 *  wrong for any report other than the single most recent one) — and
 *  celebrates an improvement. */
function FocusSkillLead({
  report,
  callId
}: {
  report: CoachingReport
  callId: string
}): React.JSX.Element | null {
  const focus = report.focusSkillAtCoaching
  // Skip the IPC round-trip entirely when there's nothing to show — this
  // component mounts for EVERY coached call, including pre-M23 ones and
  // every call when Coach 2.0 is off, and must not do main-process work then.
  const { progress } = useSkillProgress(!!focus)
  if (!focus) return null
  const score = report.skills?.[focus.skill]
  const history = progress.find((p) => p.key === focus.skill)?.history
  const idx = history?.findIndex((h) => h.callId === callId) ?? -1
  const previous = idx > 0 ? history![idx - 1].score : undefined
  const improved = score !== undefined && previous !== undefined && score > previous

  return (
    <div className="rounded-2xl border border-accent/30 bg-accent-soft p-4">
      <div className="flex items-center gap-2 text-accent">
        <Target className="h-4 w-4" />
        <h4 className="text-xs font-semibold uppercase tracking-wide">
          Your focus: {SKILL_LABEL[focus.skill]}
        </h4>
        {improved && (
          <Badge tone="positive" icon={TrendingUp}>
            Improved
          </Badge>
        )}
      </div>
      <p className="mt-2 text-[13px] text-muted">{focus.microBehavior}</p>
      {score !== undefined && (
        <p className="mt-2 text-sm text-ink">
          This call: <span className="font-semibold tabular-nums">{score}</span>
          {previous !== undefined && (
            <span className="text-muted"> (was {previous} last time)</span>
          )}
        </p>
      )}
    </div>
  )
}

/** A1's "manual override" for call-type detection. Changing it here re-tags
 *  the call for next time (calls:setCallType) — it does NOT retroactively
 *  recompute THIS report's already-scored benchmarks, since that would mean
 *  either a second AI call or silently diverging from what was actually
 *  scored; the toast says so. */
function CallTypePicker({
  callId,
  callType
}: {
  callId: string
  callType: CallType
}): React.JSX.Element {
  const toast = useToast()
  const [value, setValue] = useState(callType)
  const [saving, setSaving] = useState(false)

  const onChange = async (next: CallType): Promise<void> => {
    setValue(next)
    setSaving(true)
    try {
      await window.api.calls.setCallType(callId, next)
      toast.success('Saved — used next time this call is re-coached.')
    } catch {
      toast.error('Could not save the call type. Please try again.')
      setValue(callType)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="text-[11px] text-faint">Call type:</span>
      <SegmentedControl
        options={CALL_TYPES.map((t) => ({ id: t, label: CALL_TYPE_LABEL[t] }))}
        value={value}
        disabled={saving}
        onChange={(next) => void onChange(next)}
      />
    </div>
  )
}

interface CoachReportViewProps {
  report: CoachingReport
  callId: string
  callTitle: string
  /** M19 Task 2 — resolved real names, for Evidence quote attribution. */
  identities?: SpeakerIdentities
  /** Whether the call used Deepgram multichannel — evidence.speaker doubles
   *  as the channel in that mode (they're the same value; see
   *  transcription.ts), so this is needed to look up the right identity key.
   *  CoachEvidence doesn't carry channel directly. */
  multichannel?: boolean
}

export function CoachReportView({
  report,
  callId,
  callTitle,
  identities,
  multichannel = false
}: CoachReportViewProps): React.JSX.Element {
  const tier = overallTier(report.overallScore)
  const repSpeaker = report.metrics.repSpeaker
  const dims = DIMENSION_ORDER.map((k) => report.dimensions.find((d) => d.key === k)).filter(
    (d): d is CoachDimension => Boolean(d)
  )
  const toast = useToast()
  const [exporting, setExporting] = useState(false)
  // A personalized "earned" milestone: how much this call improved on the
  // rep's own immediately-preceding coached call with the SAME contact (not
  // an average, not an absolute threshold). Client-side only, over data the
  // call list already carries (contactId/hasCoaching/coachScore/createdAt) —
  // no new IPC, no new storage. Stays null (renders nothing) while loading,
  // if this call isn't linked to a contact, if there's no prior coached call
  // for that contact, or if the trend isn't an improvement.
  const [scoreDelta, setScoreDelta] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    // Reset for the newly-scored call before the async fetch resolves,
    // matching the pattern used by useContactCallHistory.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScoreDelta(null)
    void (async () => {
      try {
        const summaries = await window.api.calls.list()
        const current = summaries.find((c) => c.id === callId)
        if (!current?.contactId) return
        const previous = summaries
          .filter(
            (c) =>
              c.id !== callId &&
              c.contactId === current.contactId &&
              c.hasCoaching &&
              typeof c.coachScore === 'number' &&
              c.createdAt < current.createdAt
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        if (!previous || typeof previous.coachScore !== 'number') return
        const delta = report.overallScore - previous.coachScore
        if (!active) return
        if (delta > 0) setScoreDelta(delta)
      } catch {
        /* no milestone badge is fine — this is a bonus, not the main render */
      }
    })()
    return () => {
      active = false
    }
  }, [callId, report.overallScore])

  const exportPdf = async (): Promise<void> => {
    setExporting(true)
    try {
      const result = await window.api.calls.exportCoachingPdf(callId)
      if (result.ok) {
        toast.success('Coaching report saved as PDF')
      } else if (result.error !== 'canceled') {
        toast.error('Could not export the PDF. Please try again.')
      }
    } catch {
      toast.error('Could not export the PDF. Please try again.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* M23 A4 — leads the report when this call had an active Focus Skill */}
      <FocusSkillLead report={report} callId={callId} />

      {/* Toolbar */}
      <div className="flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => void exportPdf()} disabled={exporting}>
          {exporting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Exporting…
            </>
          ) : (
            <>
              <FileDown className="h-3.5 w-3.5" /> Export PDF
            </>
          )}
        </Button>
      </div>

      {/* Overall + deal context */}
      <div
        className={cn(
          'flex items-center gap-4 rounded-2xl border border-line-soft bg-canvas p-5',
          report.overallScore >= 85 && 'animate-pop'
        )}
      >
        <ScoreGauge score={report.overallScore} size={72} tone={TONE_TO_GAUGE[tier.tone]} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={TONE_TO_BADGE[tier.tone]}>{tier.label} call</Badge>
            {report.overallScore >= 85 && (
              <Badge tone="positive" icon={Trophy}>
                Great call
              </Badge>
            )}
            {scoreDelta !== null && (
              <Badge tone="positive" icon={TrendingUp}>
                +{scoreDelta} pts since your last call with this contact
              </Badge>
            )}
          </div>
          {report.dealContext.summary && (
            <p className="mt-1.5 text-[13px] text-muted">{report.dealContext.summary}</p>
          )}
          {report.dealContext.lens && (
            <p className="mt-1 text-[11px] text-faint">Lens: {report.dealContext.lens}</p>
          )}
          {report.callType && <CallTypePicker callId={callId} callType={report.callType} />}
        </div>
      </div>

      {/* Deterministic metrics */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5">
        {metricRows(report.metrics).map((m) => (
          <div key={m.label} className="rounded-xl border border-line-soft bg-canvas px-3 py-2">
            <p className="text-[10px] uppercase tracking-wide text-faint">{m.label}</p>
            <p className={cn('text-sm font-semibold tabular-nums', TONE_TEXT[m.tone])}>{m.value}</p>
            <p className="text-[10px] text-faint">{m.hint}</p>
          </div>
        ))}
      </div>

      {/* Lead strength */}
      {report.strength.text && (
        <div className="rounded-2xl border border-positive/30 bg-positive-soft p-4">
          <div className="flex items-center gap-2 text-positive">
            <Award className="h-4 w-4" />
            <h4 className="text-xs font-semibold uppercase tracking-wide">What worked</h4>
          </div>
          <p className="mt-2 text-sm text-ink">{report.strength.text}</p>
          {report.strength.evidence && (
            <Evidence ev={report.strength.evidence} repSpeaker={repSpeaker} identities={identities} multichannel={multichannel} />
          )}
        </div>
      )}

      {/* Top-2 improvements */}
      {report.improvements.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {report.improvements.map((imp, i) => (
            <div key={i} className="rounded-2xl border border-line-soft bg-canvas p-4">
              <div className="flex items-center gap-2">
                <Badge
                  tone={imp.kind === 'mechanical' ? 'neutral' : 'accent'}
                  icon={imp.kind === 'mechanical' ? Wrench : Lightbulb}
                >
                  {imp.kind === 'mechanical' ? 'Quick fix' : 'Strategic'}
                </Badge>
              </div>
              <p className="mt-2 text-sm font-medium text-ink">{imp.title}</p>
              {imp.detail && <p className="mt-1 text-[13px] text-muted">{imp.detail}</p>}
              {imp.evidence && (
                <Evidence ev={imp.evidence} repSpeaker={repSpeaker} identities={identities} multichannel={multichannel} />
              )}
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
              {d.evidence && (
                <Evidence ev={d.evidence} repSpeaker={repSpeaker} identities={identities} multichannel={multichannel} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* M23 A2 — Skill Graph, per-call. Only present when Coach 2.0 was on. */}
      {report.skills && (
        <div className="rounded-2xl border border-line-soft bg-canvas p-5">
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Skills</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            {SKILL_KEYS.map((key) => {
              const score = report.skills![key]
              return (
                <div key={key}>
                  <div className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="font-medium">{SKILL_LABEL[key]}</span>
                    <span className="tabular-nums text-muted">{score}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-line">
                    <div
                      className="h-1.5 rounded-full bg-accent"
                      style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          {report.methodologyAdherence && (
            <div className="mt-4 border-t border-line-soft pt-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">
                  {METHODOLOGY_LABEL[report.methodologyAdherence.methodology]} adherence
                </span>
                <ScoreBar score={report.methodologyAdherence.score} />
              </div>
              {report.methodologyAdherence.comment && (
                <p className="mt-1 text-[13px] text-muted">{report.methodologyAdherence.comment}</p>
              )}
              {report.methodologyAdherence.evidence && (
                <Evidence
                  ev={report.methodologyAdherence.evidence}
                  repSpeaker={repSpeaker}
                  identities={identities}
                  multichannel={multichannel}
                />
              )}
            </div>
          )}
        </div>
      )}

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
  repSpeaker,
  identities,
  multichannel
}: {
  ev: CoachEvidence
  repSpeaker: number | null
  identities?: SpeakerIdentities
  multichannel?: boolean
}): React.JSX.Element {
  // Evidence quotes don't carry channel directly — in multichannel mode
  // speaker IS the channel (see transcription.ts), so it doubles as one.
  const channel = multichannel ? ev.speaker : undefined
  return (
    <div className="mt-2 flex gap-2 rounded-lg border-l-2 border-line bg-surface px-3 py-2">
      <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-faint" />
      <p className="text-[13px] italic leading-relaxed text-muted">
        &ldquo;{ev.quote}&rdquo;{' '}
        <span className="text-faint not-italic">
          — {speakerLabel(ev.speaker, repSpeaker, undefined, undefined, identities, channel)}
        </span>
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
            ? 'cursor-default bg-positive-soft text-positive'
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
      {error && <p className="mt-2 text-[13px] text-danger">{error}</p>}
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
      <Skeleton className="h-16 rounded-2xl" />
      <div className="flex gap-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 flex-1 rounded-xl" />
        ))}
      </div>
      <div className="space-y-2.5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-6" />
        ))}
      </div>
    </div>
  )
}
