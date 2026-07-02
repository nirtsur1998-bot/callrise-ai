import { useEffect, useState } from 'react'
import { ArrowLeft, Trash2, Clock, Users, PhoneCall } from 'lucide-react'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import { useCalls } from './useCalls'
import type { Call } from './types'

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function PastCallsView(): React.JSX.Element {
  const { calls, loading, remove, get } = useCalls()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Call | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  useEffect(() => {
    setSelected(null)
    if (!selectedId) return
    let active = true
    void get(selectedId).then((call) => {
      if (!active) return
      if (call) setSelected(call)
      else setSelectedId(null) // missing/corrupt file — return to the list
    })
    return () => {
      active = false
    }
  }, [selectedId, get])

  // --- Detail view ---------------------------------------------------------
  if (selectedId) {
    if (!selected) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
      )
    }
    return (
      <div className="flex h-full flex-col">
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="flex items-center gap-2 text-sm text-muted transition hover:text-ink"
          >
            <ArrowLeft className="h-4 w-4" /> Past Calls
          </button>
          <button
            type="button"
            onClick={async () => {
              await remove(selected.id)
              setSelectedId(null)
            }}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:border-rose-500/40 hover:text-rose-300"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
        <div className="mb-5">
          <h2 className="text-xl font-semibold tracking-tight">{selected.title}</h2>
          <div className="mt-1.5 flex items-center gap-4 text-[13px] text-muted">
            <span>{formatDate(selected.createdAt)}</span>
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" /> {formatDuration(selected.durationMs)}
            </span>
            <span className="flex items-center gap-1">
              <Users className="h-3.5 w-3.5" /> {selected.speakerCount} speaker
              {selected.speakerCount === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto rounded-2xl border border-line-soft bg-surface px-7 py-6">
          {selected.segments.length > 0 ? (
            <SpeakerTranscript segments={selected.segments} />
          ) : (
            <p className="text-sm text-faint">This call has no transcript.</p>
          )}
        </div>
      </div>
    )
  }

  // --- List view -----------------------------------------------------------
  if (loading) {
    return <div className="flex h-full items-center justify-center text-sm text-faint">Loading…</div>
  }

  if (calls.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
          <PhoneCall className="h-6 w-6 text-faint" />
        </div>
        <h2 className="text-lg font-semibold">No saved calls yet</h2>
        <p className="mt-1.5 max-w-xs text-sm text-muted">
          Start a live call and stop it — it&rsquo;ll be saved here automatically.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight">Past Calls</h2>
        <span className="text-[13px] text-faint">
          {calls.length} call{calls.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul className="space-y-2.5">
        {calls.map((call) => (
          <li key={call.id}>
            <div className="group flex items-center gap-4 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
              <button
                type="button"
                onClick={() => setSelectedId(call.id)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate font-medium">{call.title}</p>
                <p className="mt-0.5 truncate text-[13px] text-muted">
                  {call.preview || 'No transcript'}
                </p>
                <div className="mt-1.5 flex items-center gap-3 text-[11px] text-faint">
                  <span>{formatDate(call.createdAt)}</span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" /> {formatDuration(call.durationMs)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users className="h-3 w-3" /> {call.speakerCount}
                  </span>
                </div>
              </button>
              {confirmId === call.id ? (
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      setConfirmId(null)
                      await remove(call.id)
                    }}
                    className="rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(null)}
                    className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmId(call.id)}
                  title="Delete"
                  className="shrink-0 rounded-lg p-2 text-faint opacity-0 transition hover:bg-canvas hover:text-rose-300 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
