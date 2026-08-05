import { useCallback, useEffect, useRef, useState } from 'react'
import { X, ListChecks, Sparkles, RotateCw, Trash2, Info } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { Skeleton } from '@renderer/components/Skeleton'
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

  const updateRow = (key: string, draft: TaskDraft): void =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, draft } : r)))

  const discardRow = (key: string): void => setRows((prev) => prev.filter((r) => r.key !== key))

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    const totalToSave = rows.length
    // M23 bug hunt: if the Nth create() throws, rows 1..N-1 are already
    // persisted, but `rows` state used to stay untouched — clicking "Save"
    // again (the error message's own instruction) resubmitted EVERYTHING,
    // duplicating every task that had already succeeded, with no way to
    // tell which ones were the dupes. `remaining` is a plain local snapshot
    // (not React state read back mid-loop, which would depend on exactly
    // when React flushes the setRows() below relative to the next
    // iteration — not something to build correctness on) shrunk by one on
    // every successful create(); setRows() alongside it only drives what's
    // displayed. A retry only ever re-attempts whatever's actually left in
    // `rows` at the moment "Save" is clicked again.
    let remaining = rows
    try {
      while (remaining.length > 0) {
        const row = remaining[0]
        await window.api.tasks.create({
          title: row.draft.title.trim() || 'Untitled task',
          type: row.draft.type,
          priority: row.draft.priority,
          dueAt: row.draft.dueAt ?? null,
          clientName: row.draft.clientName.trim() || null,
          note: row.draft.note.trim() || null,
          callId,
          callTitle,
          source: 'ai'
        })
        remaining = remaining.slice(1)
        if (!mountedRef.current) return
        setRows(remaining)
      }
      onSaved(totalToSave) // parent unmounts the dialog
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
    <Modal
      onClose={requestClose}
      title="Generate tasks"
      size="lg"
      className="flex max-h-[85vh] flex-col"
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
        <IconButton icon={X} label="Close" onClick={requestClose} disabled={saving} />
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
              <Button variant="secondary" size="sm" icon={RotateCw} onClick={reload}>
                Regenerate
              </Button>
            </div>
            {rows.map((row) => (
              <div
                key={row.key}
                className="relative rounded-xl border border-line-soft bg-canvas p-4 pr-12"
              >
                <IconButton
                  icon={Trash2}
                  label="Discard this task"
                  onClick={() => discardRow(row.key)}
                  variant="danger"
                  className="absolute top-3 right-3"
                />
                <TaskEditor value={row.draft} onChange={(draft) => updateRow(row.key, draft)} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer (only meaningful when there are tasks to save) */}
      {!loading && !error && rows.length > 0 && (
        <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
          <p className="text-[13px] text-danger">{saveError}</p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={requestClose} disabled={saving}>
              Cancel
            </Button>
            <Button icon={ListChecks} onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : `Save ${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`}
            </Button>
          </div>
        </div>
      )}
    </Modal>
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
    <div className="space-y-4" aria-busy="true" aria-label="Generating tasks">
      <div className="flex items-center gap-2.5 text-sm text-muted">
        <Sparkles className="h-4 w-4 animate-pulse text-accent" />
        <span>Reading the call and drafting tasks…</span>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2.5 rounded-xl border border-line-soft bg-canvas p-4">
          <Skeleton className="h-3.5 w-3/4" />
          <div className="flex gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
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
      <div className="rounded-xl border border-warning/30 bg-warning-soft p-4 text-sm text-warning">
        <p className="font-medium">Add your Anthropic API key</p>
        <p className="mt-1 opacity-90">
          Generating tasks needs an Anthropic key. Get one at console.anthropic.com, paste it into{' '}
          <span className="text-ink">Settings → API keys</span>, then try again — it takes effect
          immediately, no restart needed.
        </p>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-start gap-3 py-4">
      <p className="text-sm text-danger">{error.message}</p>
      <Button variant="secondary" icon={RotateCw} onClick={onRetry}>
        Try again
      </Button>
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
      <Button variant="secondary" icon={RotateCw} onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
