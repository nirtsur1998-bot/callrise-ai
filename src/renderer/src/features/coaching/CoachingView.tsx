import { useEffect, useRef, useState } from 'react'
import { GraduationCap, ArrowLeft, Clock } from 'lucide-react'
import { EmptyState } from '@renderer/components/EmptyState'
import { PageHeader } from '@renderer/components/PageHeader'
import { ScoreGauge } from '@renderer/components/ScoreGauge'
import { SkeletonRows, Skeleton } from '@renderer/components/Skeleton'
import { Badge } from '@renderer/components/Badge'
import { useCalls } from '@renderer/features/calls/useCalls'
import { formatDate, formatDuration } from '@renderer/features/calls/format'
import type { Call } from '@renderer/features/calls/types'
import { CoachReportView } from './CoachReportView'
import { overallTier, TONE_TO_BADGE, TONE_TO_GAUGE } from './meta'

export function CoachingView(): React.JSX.Element {
  const { calls, loading } = useCalls()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (selectedId) {
    return <CoachingDetail callId={selectedId} onBack={() => setSelectedId(null)} />
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl">
        <SkeletonRows rows={4} />
      </div>
    )
  }

  const coached = calls.filter((c) => c.hasCoaching)

  if (coached.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={GraduationCap}
          title="Coach your first call"
          titleAs="h2"
          description="Open a saved call and choose “Coach this call” for an evidence-based scorecard. Coached calls show up here."
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Coaching"
        count={`${coached.length} coached call${coached.length === 1 ? '' : 's'}`}
      />
      <ul className="space-y-2.5">
        {coached.map((c, index) => {
          const tier = c.coachScore !== undefined ? overallTier(c.coachScore) : null
          return (
            <li
              key={c.id}
              className="stagger-item"
              style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}
            >
              <button
                type="button"
                onClick={() => setSelectedId(c.id)}
                className="group flex w-full items-center gap-4 rounded-xl border border-line-soft bg-surface px-4 py-3.5 text-left shadow-card transition hover:border-line hover:bg-elevated"
              >
                {c.coachScore !== undefined && tier ? (
                  <ScoreGauge score={c.coachScore} size={48} tone={TONE_TO_GAUGE[tier.tone]} />
                ) : (
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-elevated text-muted">
                    –
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{c.title}</p>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-faint">
                    <span>{formatDate(c.createdAt)}</span>
                    <span>{formatDuration(c.durationMs)}</span>
                    {tier && <Badge tone={TONE_TO_BADGE[tier.tone]}>{tier.label}</Badge>}
                  </div>
                </div>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function CoachingDetail({
  callId,
  onBack
}: {
  callId: string
  onBack: () => void
}): React.JSX.Element {
  const [call, setCall] = useState<Call | null>(null)
  const [loaded, setLoaded] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    void window.api.calls.get(callId).then((c) => {
      if (!mountedRef.current) return
      setCall(c)
      setLoaded(true)
    })
  }, [callId])

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 flex items-center gap-2 text-sm text-muted transition hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Coaching
      </button>

      {!loaded ? (
        <div className="space-y-4">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
      ) : !call || !call.coaching ? (
        <EmptyState
          icon={GraduationCap}
          title="This coaching report is no longer available"
          titleAs="h2"
          description="The call it belonged to may have been deleted."
        />
      ) : (
        <div className="flex-1 overflow-y-auto pb-2">
          <div className="mb-4">
            <h2 className="text-xl font-semibold tracking-tight">{call.title}</h2>
            <p className="mt-1 flex items-center gap-2 text-[13px] text-muted">
              <Clock className="h-3.5 w-3.5" /> {formatDate(call.createdAt)}
            </p>
          </div>
          <CoachReportView report={call.coaching} callId={call.id} callTitle={call.title} />
        </div>
      )}
    </div>
  )
}
