import { useCallback, useEffect, useRef, useState } from 'react'
import { X, ListChecks, Sparkles, RotateCw, Trash2, Info } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { Skeleton } from '@renderer/components/Skeleton'
import { useJobByTarget } from '@renderer/features/jobs/useJobByTarget'
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

// M26 Phase 3 — the actual bug fix here (not just an architecture move):
// this job type's resultData holds the AI's proposed tasks the instant the
// call finishes, so the JOB — not this dialog's own React state — is the
// source of truth. Closing the dialog before Save can no longer discard
// already-paid-for AI output: reopening "Generate tasks" for the same call
// (even after a full app restart) re-adopts the same finished job and
// shows the same proposals, never re-running the AI call.
const GENERATE_TASKS_JOB_TYPE = 'tasks:generateFromCall'

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

function tasksFromResultData(resultData: unknown): ProposedTask[] {
  const tasks = (resultData as { tasks?: unknown } | undefined)?.tasks
  return Array.isArray(tasks) ? (tasks as ProposedTask[]) : []
}

export function GenerateTasksDialog({
  callId,
  callTitle,
  onClose,
  onSaved
}: GenerateTasksDialogProps): React.JSX.Element {
  const [dialogError, setDialogError] = useState<DialogError | null>(null)
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

  // Also adopts an already-SUCCEEDED job (not just running/queued) — the
  // one difference from every other Phase 3 job-tracking screen, and the
  // whole point of this fix: a not-yet-reviewed result must be recoverable
  // by reopening, not just by watching a still-in-flight job finish.
  const [job, start] = useJobByTarget(GENERATE_TASKS_JOB_TYPE, callId, {
    adoptStates: ['running', 'queued', 'succeeded'],
    onSucceeded: (finished) => {
      const tasks = tasksFromResultData(finished.resultData)
      setRows(tasks.map((t) => ({ key: `t${keyCounter.current++}`, draft: toDraft(t) })))
    },
    onFailed: (failed) => {
      if (failed.error?.code === 'no-key') setDialogError({ kind: 'no-key' })
      else {
        setDialogError({
          kind: 'failed',
          message: failed.error?.message ?? 'Could not generate tasks.'
        })
      }
    }
  })
  const loading = !job || job.state === 'running' || job.state === 'queued'

  // The fetch itself sets no state until after the await, so it's safe to call
  // straight from an effect (no synchronous render churn). `force` bypasses
  // adopting an existing succeeded job — Regenerate/Try again always want a
  // genuinely fresh attempt, not the one just shown.
  const startGeneration = useCallback(
    async (opts?: { force?: boolean }): Promise<void> => {
      try {
        const res = await window.api.tasks.generateFromCall(callId, opts)
        if (!mountedRef.current) return
        if (res.ok && res.jobId) {
          const fresh = await window.api.jobs.get(res.jobId)
          if (mountedRef.current && fresh) start(fresh)
        } else {
          setDialogError({ kind: 'failed', message: 'Could not generate tasks. Please try again.' })
        }
      } catch {
        if (mountedRef.current) {
          setDialogError({ kind: 'failed', message: 'Could not generate tasks. Please try again.' })
        }
      }
    },
    [callId, start]
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- startGeneration only sets state after an await, same as every other adapter's mount-time start
    void startGeneration()
  }, [startGeneration])

  // Used by the Regenerate / Try again buttons: reset to a clean loading
  // state and force a genuinely new job.
  const reload = useCallback(() => {
    setDialogError(null)
    setSaveError(null)
    setRows([])
    void startGeneration({ force: true })
  }, [startGeneration])

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
      // The proposals are consumed now — clear the job so reopening
      // "Generate tasks" for this call later doesn't resurface an
      // already-saved batch (best-effort: a failure just leaves it in
      // Activity Center history, harmless). Goes through a purpose-built
      // channel, not the generic jobs.dismiss, which deliberately cannot
      // clear a job still holding unreviewed output (BUG-052).
      if (job) void window.api.tasks.markGenerationConsumed(job.id).catch(() => {})
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
        ) : dialogError ? (
          <ErrorState error={dialogError} onRetry={reload} />
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
      {!loading && !dialogError && rows.length > 0 && (
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
