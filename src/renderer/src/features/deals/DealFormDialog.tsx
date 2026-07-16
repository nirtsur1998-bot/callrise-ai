import { useState } from 'react'
import { X } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { DealEditor } from './DealEditor'
import { emptyDraft, type DealDraft } from './draft'
import type { Deal, DealStage } from './types'

export interface DealFormValues {
  title: string
  contactId: string
  stageId: string
  value: number | null
  expectedCloseDate: string | null
  notes: string | null
}

interface DealFormDialogProps {
  /** When editing, the deal to prefill from. Omit to add a new deal. */
  deal?: Deal
  stages: DealStage[]
  onClose: () => void
  onSubmit: (values: DealFormValues) => Promise<void>
}

function draftFromDeal(deal: Deal): DealDraft {
  return {
    title: deal.title,
    contactId: deal.contactId,
    stageId: deal.stageId,
    value: deal.value !== undefined ? String(deal.value) : '',
    expectedCloseDate: deal.expectedCloseDate ?? '',
    notes: deal.notes ?? ''
  }
}

export function DealFormDialog({
  deal,
  stages,
  onClose,
  onSubmit
}: DealFormDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<DealDraft>(() =>
    deal ? draftFromDeal(deal) : emptyDraft(stages[0]?.id ?? '')
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEdit = Boolean(deal)
  const canSave = draft.title.trim().length > 0 && Boolean(draft.contactId) && !saving

  // The Modal's Escape handler always fires — guard the close itself instead,
  // so a save in flight can't be abandoned mid-write.
  const guardedClose = (): void => {
    if (!saving) onClose()
  }

  const submit = async (): Promise<void> => {
    if (!canSave || !draft.contactId) return
    setSaving(true)
    setError(null)
    try {
      const parsedValue = draft.value.trim() ? Number(draft.value) : null
      await onSubmit({
        title: draft.title.trim(),
        contactId: draft.contactId,
        stageId: draft.stageId,
        value: parsedValue !== null && Number.isFinite(parsedValue) ? parsedValue : null,
        expectedCloseDate: draft.expectedCloseDate || null,
        notes: draft.notes.trim() || null
      })
      // Parent closes the dialog on success.
    } catch {
      setSaving(false)
      setError('Could not save the deal. Please try again.')
    }
  }

  return (
    <Modal
      onClose={guardedClose}
      title={isEdit ? 'Edit deal' : 'Add deal'}
      initialFocus={false}
      className="flex max-h-[85vh] flex-col"
    >
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <h2 className="text-sm font-semibold">{isEdit ? 'Edit deal' : 'Add deal'}</h2>
        <IconButton icon={X} label="Close" onClick={guardedClose} disabled={saving} />
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <DealEditor value={draft} onChange={setDraft} stages={stages} autoFocus />
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
        <p className="text-[13px] text-danger">{error}</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={guardedClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add deal'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
