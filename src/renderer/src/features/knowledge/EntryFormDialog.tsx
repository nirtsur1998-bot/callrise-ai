import { useState } from 'react'
import { X } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { IconButton } from '@renderer/components/IconButton'
import { Button } from '@renderer/components/Button'
import { fieldClass } from '@renderer/components/field'
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
    <Modal
      onClose={guardedClose}
      title={isEdit ? `Edit ${meta.singular}` : `Add ${meta.singular}`}
      size="lg"
      initialFocus={false}
      className="flex max-h-[85vh] flex-col"
    >
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <h2 className="text-sm font-semibold">
          {isEdit ? `Edit ${meta.singular}` : `Add ${meta.singular}`}
        </h2>
        <IconButton icon={X} label="Close" onClick={guardedClose} disabled={saving} />
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
                className={fieldClass}
              />
            </Field>
            <Field label="Here's how I respond">
              <textarea
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                maxLength={3000}
                placeholder="e.g. We're priced above X, but here's the ROI argument…"
                rows={6}
                className={`${fieldClass} resize-y`}
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
                className={fieldClass}
              />
            </Field>
            <Field label="Content">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={20000}
                rows={10}
                className={`${fieldClass} resize-y`}
              />
            </Field>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
        <p className="text-[13px] text-danger">{error}</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={guardedClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add'}
          </Button>
        </div>
      </div>
    </Modal>
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
