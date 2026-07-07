import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import type { KnowledgeCategory, KnowledgeEntry } from './types'
import { CATEGORY_META } from './meta'

export interface EntryFormValues {
  trigger?: string
  response?: string
  title?: string
  body?: string
}

interface EntryFormDialogProps {
  category: KnowledgeCategory
  /** When editing, the entry to prefill from. Omit to add a new entry. */
  entry?: KnowledgeEntry
  onClose: () => void
  onSubmit: (values: EntryFormValues) => Promise<void>
}

export function EntryFormDialog({
  category,
  entry,
  onClose,
  onSubmit
}: EntryFormDialogProps): React.JSX.Element {
  const isObjection = category === 'objection'
  const isEdit = Boolean(entry)
  const meta = CATEGORY_META[category]

  const [trigger, setTrigger] = useState(entry?.category === 'objection' ? entry.trigger : '')
  const [response, setResponse] = useState(entry?.category === 'objection' ? entry.response : '')
  const [title, setTitle] = useState(entry && entry.category !== 'objection' ? entry.title : '')
  const [body, setBody] = useState(entry && entry.category !== 'objection' ? entry.body : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = isObjection
    ? trigger.trim().length > 0 && response.trim().length > 0 && !saving
    : title.trim().length > 0 && body.trim().length > 0 && !saving

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
      await onSubmit(
        isObjection
          ? { trigger: trigger.trim(), response: response.trim() }
          : { title: title.trim(), body: body.trim() }
      )
      // Parent closes the dialog on success.
    } catch {
      setSaving(false)
      setError('Could not save. Please try again.')
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
        aria-label={isEdit ? `Edit ${meta.singular}` : `Add ${meta.singular}`}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
          <h2 className="text-sm font-semibold">
            {isEdit ? `Edit ${meta.singular}` : `Add ${meta.singular}`}
          </h2>
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

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {isObjection ? (
            <>
              <Field label="When the buyer says…">
                <input
                  autoFocus
                  value={trigger}
                  onChange={(e) => setTrigger(e.target.value)}
                  maxLength={300}
                  placeholder="e.g. It's too expensive"
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </Field>
              <Field label="Here's how I respond">
                <textarea
                  value={response}
                  onChange={(e) => setResponse(e.target.value)}
                  maxLength={3000}
                  placeholder="e.g. We're priced above X, but here's the ROI argument…"
                  rows={6}
                  className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Section title">
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  placeholder={
                    category === 'product' ? 'e.g. What we offer' : 'e.g. Discovery questions'
                  }
                  className="w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </Field>
              <Field label="Content">
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={20000}
                  rows={10}
                  className="w-full resize-y rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-accent"
                />
              </Field>
            </>
          )}
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
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>
      {children}
    </label>
  )
}
