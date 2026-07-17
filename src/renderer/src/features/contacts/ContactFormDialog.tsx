import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { ContactEditor } from './ContactEditor'
import { emptyDraft, type ContactDraft } from './draft'
import type { Contact } from './types'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'

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
  const { settings } = useAppSettings()
  const [draft, setDraft] = useState<ContactDraft>(() =>
    contact ? draftFromContact(contact) : emptyDraft(settings.crm.defaultCountry)
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Settings load ASYNC — the initializer above almost always runs before the
  // real defaultCountry arrives, so "Default country for new contacts" never
  // pre-filled. Backfill once it loads, but only while the user hasn't picked
  // a country themselves (and never when editing an existing contact).
  useEffect(() => {
    const def = settings.crm.defaultCountry
    if (contact || !def) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing the draft with the async-loaded setting
    setDraft((d) => (d.country ? d : { ...d, country: def }))
  }, [settings.crm.defaultCountry, contact])

  const isEdit = Boolean(contact)
  const canSave = draft.name.trim().length > 0 && !saving

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
    } catch (err) {
      console.error('Failed to save contact:', err)
      setSaving(false)
      setError(
        `Could not save the contact. ${err instanceof Error ? err.message : 'Please try again.'}`
      )
    }
  }

  return (
    <Modal
      onClose={guardedClose}
      title={isEdit ? 'Edit contact' : 'Add contact'}
      size="lg"
      initialFocus={false}
      className="flex max-h-[85vh] flex-col"
    >
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <h2 className="text-sm font-semibold">{isEdit ? 'Edit contact' : 'Add contact'}</h2>
        <IconButton icon={X} label="Close" onClick={guardedClose} disabled={saving} />
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <ContactEditor value={draft} onChange={setDraft} autoFocus />
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
        <p className="text-[13px] text-danger">{error}</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={guardedClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add contact'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
