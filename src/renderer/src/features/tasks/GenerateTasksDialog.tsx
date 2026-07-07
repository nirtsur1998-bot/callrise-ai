import { useCallback, useEffect, useRef, useState } from 'react'
import { X, ListChecks, Sparkles, RotateCw, Trash2, Info } from 'lucide-react'
import { TaskEditor } from './TaskEditor'
import type { TaskDraft } from './draft'
import type { ProposedTask } from './types'

interface GenerateTasksDialogProps {
  callId: string
  callTitle: string
  onClose: () => void
  onSaved: (count: number) => void
}

interface DraftRow {
  key: string
  draft: TaskDraft
}

type DialogError = { kind: 'no-key' } | { kind: 'failed'; message: string }

function toDraft(p: ProposedTask): TaskDraft {
  return {
    title: p.title,
    type: p.type,
    priority: p.priority,
    dueAt: p.dueAt,
    clientName: p.clientName ?? '',
    note: p.note ?? ''
  }
}

export function GenerateTasksDialog({
  callId,
  callTitle,
  onClose,
  onSaved
}: GenerateTasksDialogProps): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<DialogError | null>(null)
  const [rows, setRows] = useState<DraftRow[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const mountedRef = useRef(true)
  const keyCounter = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The fetch itself sets no state until after the await, so it's safe to call
  // straight from an effect (no synchronous render churn).
  const load = useCallback(async () => {
    try {
      const res = await window.api.tasks.generateFromCall(callId)
      if (!mountedRef.current) return
      if (res.ok) {
        setRows(res.tasks.map((t) => ({ key: `t${keyCounter.current++}`, draft: toDraft(t) })))
      } else if (res.error === 'no-key') {
        setError({ kind: 'no-key' })
      } else {
        setError({ kind: 'failed', message: res.message ?? 'Could not generate tasks.' })
      }
    } catch {
      if (mountedRef.current) {
        setError({ kind: 'failed', message: 'Could not generate tasks. Please try again.' })
      }
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [callId])

  // Used by the Regenerate / Try again buttons: reset to a clean loading state.
  const reload = useCallback(() => {
    setLoading(true)
    setError(null)
    setSaveError(null)
    setRows([])
    void load()
  }, [load])

  useEffect(() => {
    void load()
  }, [load])

  // Close on Escape (but never mid-save, so we don't abandon writes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const updateRow = (key: string, draft: TaskDraft): void =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, draft } : r)))

  const discardRow = (key: string): void => setRows((prev) => prev.filter((r) => r.key !== key))

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    try {
      for (const { draft } of rows) {
        await window.api.tasks.create({
          title: draft.title.trim() || 'Untitled task',
          type: draft.type,
          priority: draft.priority,
          dueAt: draft.dueAt ?? null,
          clientName: draft.clientName.trim() || null,
          note: draft.note.trim() || null,
          callId,
          callTitle,
          source: 'ai'
        })
      }
      onSaved(rows.length) // parent unmounts the dialog
    } catch {
      if (mountedRef.current) {
        setSaving(false)
        setSaveError('Could not save the tasks. Please try again.')
      }
    }
  }

  const requestClose = (): void => {
    if (!saving) onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Generate tasks"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-line-soft px-6 py-4">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft">
              <ListChecks className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Generate tasks</h2>
              <p className="truncate text-[12px] text-faint">{callTitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={saving}
            title="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <GeneratingState />
          ) : error ? (
            <ErrorState error={error} onRetry={reload} />
          ) : rows.length === 0 ? (
            <EmptyState onRetry={reload} />
          ) : (
            <div className="space-y-4">
              <RemindersOnlyNote />
              <div className="flex items-center justify-between">
                <p className="text-[13px] text-muted">
                  {rows.length} suggested {rows.length === 1 ? 'task' : 'tasks'} — edit or discard
                  before saving.
                </p>
                <button
                  type="button"
                  onClick={reload}
                  className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
                >
                  <RotateCw className="h-3.5 w-3.5" /> Regenerate
                </button>
              </div>
              {rows.map((row) => (
                <div
                  key={row.key}
                  className="relative rounded-xl border border-line-soft bg-canvas p-4 pr-12"
                >
                  <button
                    type="button"
                    onClick={() => discardRow(row.key)}
                    title="Discard this task"
                    className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-rose-300"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                  <TaskEditor value={row.draft} onChange={(draft) => updateRow(row.key, draft)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer (only meaningful when there are tasks to save) */}
        {!loading && !error && rows.length > 0 && (
          <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
            <p className="text-[13px] text-rose-300">{saveError}</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={requestClose}
                disabled={saving}
                className="rounded-lg border border-line px-3.5 py-2 text-sm text-muted transition hover:text-ink disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-60"
              >
                <ListChecks className="h-4 w-4" />
                {saving ? 'Saving…' : `Save ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function RemindersOnlyNote(): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-line-soft bg-canvas px-4 py-3 text-[13px] text-muted">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-faint" />
      <p>
        These are reminders only. CallRise AI won&apos;t send emails or schedule meetings — an
        &ldquo;Email&rdquo; or &ldquo;Meeting&rdquo; task just reminds you to do it yourself.
      </p>
    </div>
  )
}

function GeneratingState(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2.5 text-sm text-muted">
        <Sparkles className="h-4 w-4 animate-pulse text-accent" />
        <span>Reading the call and drafting tasks…</span>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2.5 rounded-xl border border-line-soft bg-canvas p-4">
          <div className="h-3.5 w-3/4 animate-pulse rounded bg-elevated" />
          <div className="flex gap-2">
            <div className="h-5 w-20 animate-pulse rounded-full bg-elevated" />
            <div className="h-5 w-16 animate-pulse rounded-full bg-elevated" />
            <div className="h-5 w-24 animate-pulse rounded-full bg-elevated" />
          </div>
        </div>
      ))}
    </div>
  )
}

function ErrorState({
  error,
  onRetry
}: {
  error: DialogError
  onRetry: () => void
}): React.JSX.Element {
  if (error.kind === 'no-key') {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
        <p className="font-medium">Add your Anthropic API key</p>
        <p className="mt-1 text-amber-200/80">
          Generating tasks needs an Anthropic key. Get one at console.anthropic.com, paste it into
          the
          <code className="mx-1 rounded bg-canvas px-1 py-0.5 text-amber-100">.env</code> file as
          <code className="mx-1 rounded bg-canvas px-1 py-0.5 text-amber-100">
            ANTHROPIC_API_KEY=…
          </code>
          , then restart the app.
        </p>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-start gap-3 py-4">
      <p className="text-sm text-rose-300">{error.message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-ink"
      >
        <RotateCw className="h-4 w-4" /> Try again
      </button>
    </div>
  )
}

function EmptyState({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl border border-line-soft bg-canvas">
        <ListChecks className="h-5 w-5 text-faint" />
      </div>
      <div>
        <p className="text-sm font-medium">No clear next steps</p>
        <p className="mt-1 max-w-xs text-[13px] text-muted">
          Claude didn&apos;t find any concrete action items in this call. You can try again or add a
          task yourself from the Tasks tab.
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-2 rounded-lg border border-line px-3.5 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-ink"
      >
        <RotateCw className="h-4 w-4" /> Try again
      </button>
    </div>
  )
}
