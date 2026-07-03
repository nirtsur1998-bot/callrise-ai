import { useEffect, useRef, useState } from 'react'
import { GraduationCap, ArrowLeft, Clock } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { useCalls } from '@renderer/features/calls/useCalls'
import { formatDate } from '@renderer/features/calls/format'
import type { Call } from '@renderer/features/calls/types'
import { CoachReportView } from './CoachReportView'
import { overallTier, TONE_TEXT } from './meta'

export function CoachingView(): React.JSX.Element {
  const { calls, loading } = useCalls()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (selectedId) {
    return <CoachingDetail callId={selectedId} onBack={() => setSelectedId(null)} />
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
    )
  }

  const coached = calls.filter((c) => c.hasCoaching)

  if (coached.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
          <GraduationCap className="h-6 w-6 text-faint" strokeWidth={1.75} />
        </div>
        <h2 className="text-lg font-semibold">Coach your first call</h2>
        <p className="mt-1.5 max-w-xs text-sm text-muted">
          Open a saved call and choose &ldquo;Coach this call&rdquo; for an evidence-based
          scorecard. Coached calls show up here.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Coaching</h2>
        <span className="text-[13px] text-faint">
          {coached.length} coached call{coached.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="space-y-2.5">
        {coached.map((c) => {
          const tier = c.coachScore !== undefined ? overallTier(c.coachScore) : null
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setSelectedId(c.id)}
                className="group flex w-full items-center gap-4 rounded-xl border border-line-soft bg-surface px-4 py-3.5 text-left transition hover:border-line hover:bg-elevated"
              >
                <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-xl bg-elevated">
                  <span
                    className={cn(
                      'text-base font-bold tabular-nums',
                      tier ? TONE_TEXT[tier.tone] : 'text-muted'
                    )}
                  >
                    {c.coachScore ?? '–'}
                  </span>
                  <span className="text-[8px] uppercase tracking-wide text-faint">/ 100</span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{c.title}</p>
                  <div className="mt-1 flex items-center gap-3 text-[11px] text-faint">
                    <span>{formatDate(c.createdAt)}</span>
                    {tier && <span className={TONE_TEXT[tier.tone]}>{tier.label}</span>}
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
        <div className="flex flex-1 items-center justify-center text-sm text-faint">Loading…</div>
      ) : !call || !call.coaching ? (
        <p className="text-sm text-muted">This coaching report is no longer available.</p>
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
