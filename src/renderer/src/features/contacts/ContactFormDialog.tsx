import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { ContactEditor } from './ContactEditor'
import { emptyDraft, type ContactDraft } from './draft'
import type { Contact } from './types'

export interface ContactFormValues {
  name: string
  company: string | null
  cid: string | null
  registeredAt: string | null
  country: string | null
  email: string | null
  phoneCountry: string | null
  phone: string | null
  notes: string | null
}

interface ContactFormDialogProps {
  /** When editing, the contact to prefill from. Omit to add a new contact. */
  contact?: Contact
  onClose: () => void
  onSubmit: (values: ContactFormValues) => Promise<void>
}

function draftFromContact(contact: Contact): ContactDraft {
  return {
    name: contact.name,
    company: contact.company ?? '',
    cid: contact.cid ?? '',
    registeredAt: contact.registeredAt ?? '',
    country: contact.country,
    email: contact.email ?? '',
    phoneCountry: contact.phoneCountry,
    phone: contact.phone ?? '',
    notes: contact.notes ?? ''
  }
}

export function ContactFormDialog({
  contact,
  onClose,
  onSubmit
}: ContactFormDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<ContactDraft>(() =>
    contact ? draftFromContact(contact) : emptyDraft()
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEdit = Boolean(contact)
  const canSave = draft.name.trim().length > 0 && !saving

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
        name: draft.name.trim(),
        company: draft.company.trim() || null,
        cid: draft.cid.trim() || null,
        registeredAt: draft.registeredAt || null,
        country: draft.country ?? null,
        email: draft.email.trim() || null,
        phoneCountry: draft.phoneCountry ?? null,
        phone: draft.phone.trim() || null,
        notes: draft.notes.trim() || null
      })
      // Parent closes the dialog on success.
    } catch {
      setSaving(false)
      setError('Could not save the contact. Please try again.')
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
        aria-label={isEdit ? 'Edit contact' : 'Add contact'}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
          <h2 className="text-sm font-semibold">{isEdit ? 'Edit contact' : 'Add contact'}</h2>
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
          <ContactEditor value={draft} onChange={setDraft} autoFocus />
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
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add contact'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
