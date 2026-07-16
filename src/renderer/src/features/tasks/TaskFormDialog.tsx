import { useState } from 'react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
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

  // The Modal's Escape handler always fires — guard the close itself instead,
  // so a save in flight can't be abandoned mid-write.
  const guardedClose = (): void => {
    if (!saving) onClose()
  }

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
    <Modal
      onClose={guardedClose}
      title={isEdit ? 'Edit task' : 'Add task'}
      initialFocus={false}
      className="flex max-h-[85vh] flex-col"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
          <h2 className="text-sm font-semibold">{isEdit ? 'Edit task' : 'Add task'}</h2>
          <IconButton icon={X} label="Close" onClick={guardedClose} disabled={saving} />
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <TaskEditor value={draft} onChange={setDraft} autoFocus />
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
          <p className="text-[13px] text-danger">{error}</p>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={guardedClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={!canSave}>
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add task'}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
