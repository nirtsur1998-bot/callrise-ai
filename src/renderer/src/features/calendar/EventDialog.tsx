import { useEffect, useState, type ReactNode } from 'react'
import { X, Trash2 } from 'lucide-react'
import type { EventDraft } from './types'

const fieldClass =
  'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-faint transition focus:border-accent focus:outline-none [color-scheme:dark]'

function Field({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-faint">
        {label}
      </span>
      {children}
    </label>
  )
}

interface EventDialogProps {
  initial: EventDraft
  isEdit: boolean
  onClose: () => void
  onSubmit: (draft: EventDraft) => Promise<void>
  onDelete?: () => Promise<void>
}

export function EventDialog({
  initial,
  isEdit,
  onClose,
  onSubmit,
  onDelete
}: EventDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<EventDraft>(initial)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = (patch: Partial<EventDraft>): void => setDraft((d) => ({ ...d, ...patch }))
  const canSave = draft.title.trim().length > 0 && !busy

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(draft)
    } catch {
      setBusy(false)
      setError('Could not save the event. Please try again.')
    }
  }

  const remove = async (): Promise<void> => {
    if (!onDelete) return
    setBusy(true)
    setError(null)
    try {
      await onDelete()
    } catch {
      setBusy(false)
      setError('Could not delete the event. Please try again.')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit event' : 'New event'}
        className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
          <h2 className="text-sm font-semibold">{isEdit ? 'Edit event' : 'New event'}</h2>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            disabled={busy}
            title="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
          <Field label="Title">
            <input
              type="text"
              value={draft.title}
              autoFocus
              onChange={(e) => set({ title: e.target.value })}
              placeholder="What's happening?"
              className={fieldClass}
            />
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={draft.date}
              onChange={(e) => set({ date: e.target.value })}
              className={fieldClass}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start">
              <input
                type="time"
                value={draft.startTime}
                onChange={(e) => set({ startTime: e.target.value })}
                className={fieldClass}
              />
            </Field>
            <Field label="End">
              <input
                type="time"
                value={draft.endTime}
                onChange={(e) => set({ endTime: e.target.value })}
                className={fieldClass}
              />
            </Field>
          </div>
          <Field label="Notes (optional)">
            <textarea
              value={draft.notes}
              onChange={(e) => set({ notes: e.target.value })}
              placeholder="Anything to remember"
              rows={3}
              className={`${fieldClass} resize-none`}
            />
          </Field>
          {error && <p className="text-[13px] text-rose-300">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
          {isEdit && onDelete ? (
            confirmDelete ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={remove}
                  disabled={busy}
                  className="rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30 disabled:opacity-50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                title="Delete event"
                className="grid h-8 w-8 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-rose-300 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => !busy && onClose()}
              disabled={busy}
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
              {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add event'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
