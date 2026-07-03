import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { TaskEditor } from './TaskEditor'
import { emptyDraft, type TaskDraft } from './draft'
import type { Task } from './types'

export interface TaskFormValues {
  title: string
  type: TaskDraft['type']
  priority: TaskDraft['priority']
  dueAt: string | null
  clientName: string | null
  note: string | null
}

interface TaskFormDialogProps {
  /** When editing, the task to prefill from. Omit to add a new task. */
  task?: Task
  onClose: () => void
  onSubmit: (values: TaskFormValues) => Promise<void>
}

function draftFromTask(task: Task): TaskDraft {
  return {
    title: task.title,
    type: task.type,
    priority: task.priority,
    dueAt: task.dueAt,
    clientName: task.clientName ?? '',
    note: task.note ?? ''
  }
}

export function TaskFormDialog({
  task,
  onClose,
  onSubmit
}: TaskFormDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<TaskDraft>(() => (task ? draftFromTask(task) : emptyDraft()))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEdit = Boolean(task)
  const canSave = draft.title.trim().length > 0 && !saving

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      await onSubmit({
        title: draft.title.trim(),
        type: draft.type,
        priority: draft.priority,
        dueAt: draft.dueAt ?? null,
        clientName: draft.clientName.trim() || null,
        note: draft.note.trim() || null
      })
      // Parent closes the dialog on success.
    } catch {
      setSaving(false)
      setError('Could not save the task. Please try again.')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit task' : 'Add task'}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
          <h2 className="text-sm font-semibold">{isEdit ? 'Edit task' : 'Add task'}</h2>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            disabled={saving}
            title="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <TaskEditor value={draft} onChange={setDraft} autoFocus />
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
          <p className="text-[13px] text-rose-300">{error}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => !saving && onClose()}
              disabled={saving}
              className="rounded-lg border border-line px-3.5 py-2 text-sm text-muted transition hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!canSave}
              className="rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
            >
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add task'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
