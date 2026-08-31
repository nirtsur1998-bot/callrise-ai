import { useState } from 'react'
import { X, Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { fieldClass } from '@renderer/components/field'
import type { DealStage, DealStageKind } from './types'

const KIND_LABEL: Record<DealStageKind, string> = {
  open: 'Open',
  won: 'Won',
  lost: 'Lost',
  'went-quiet': 'Went quiet'
}
// Exhaustive by construction: a Record<DealStageKind, _> above fails the build
// when a kind is added, and this list is derived from it rather than being a
// second hand-kept copy that would silently omit the new one.
const KIND_ORDER: DealStageKind[] = Object.keys(KIND_LABEL) as DealStageKind[]

interface StageEditorDialogProps {
  stages: DealStage[]
  onClose: () => void
  onSave: (
    stages: DealStage[]
  ) => Promise<{ ok: true } | { ok: false; error: 'empty' | 'stage-in-use' }>
}

/** A simple ordered-list editor for the pipeline's stages — rename, reorder
 *  (up/down, not drag-and-drop), add, or remove. Deliberately not a workflow
 *  builder: every deal just sits in exactly one of these, in order. */
export function StageEditorDialog({
  stages,
  onClose,
  onSave
}: StageEditorDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState<DealStage[]>(stages)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = draft.some((s) => s.label.trim().length > 0) && !saving

  const update = (index: number, patch: Partial<DealStage>): void => {
    setDraft((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  }

  const move = (index: number, dir: -1 | 1): void => {
    setDraft((prev) => {
      const next = [...prev]
      const target = index + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const remove = (index: number): void => {
    setDraft((prev) => prev.filter((_, i) => i !== index))
  }

  const add = (): void => {
    setDraft((prev) => [...prev, { id: crypto.randomUUID(), label: '', kind: 'open' }])
  }

  const submit = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    const clean = draft
      .map((s) => ({ ...s, label: s.label.trim() }))
      .filter((s) => s.label.length > 0)
    const result = await onSave(clean)
    if (result.ok) return // parent closes the dialog
    setSaving(false)
    setError(
      result.error === 'stage-in-use'
        ? "Can't remove a stage that still has deals in it — move those deals first."
        : 'You need at least one stage.'
    )
  }

  // The Modal's Escape handler always fires — guard the close itself instead,
  // so a save in flight can't be abandoned mid-write. (This dialog previously
  // had NO Escape handling at all.)
  const guardedClose = (): void => {
    if (!saving) onClose()
  }

  return (
    <Modal onClose={guardedClose} title="Manage stages" className="flex max-h-[85vh] flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
        <h2 className="text-sm font-semibold">Manage stages</h2>
        <IconButton icon={X} label="Close" onClick={guardedClose} disabled={saving} />
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-6 py-5">
        <p className="mb-1 text-[13px] text-muted">
          Every deal sits in exactly one stage. Reorder with the arrows — order here is the order
          shown on the pipeline board.
        </p>
        {draft.map((stage, i) => (
          <div key={stage.id} className="flex items-center gap-1.5">
            <input
              type="text"
              value={stage.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Stage name"
              className={`min-w-0 flex-1 ${fieldClass}`}
            />
            <select
              value={stage.kind}
              onChange={(e) => update(i, { kind: e.target.value as DealStageKind })}
              className={`${fieldClass} !w-auto text-xs [color-scheme:dark]`}
            >
              {KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
            <IconButton
              icon={ArrowUp}
              label="Move up"
              onClick={() => move(i, -1)}
              disabled={i === 0}
            />
            <IconButton
              icon={ArrowDown}
              label="Move down"
              onClick={() => move(i, 1)}
              disabled={i === draft.length - 1}
            />
            <IconButton
              icon={Trash2}
              label="Remove stage"
              onClick={() => remove(i)}
              variant="danger"
            />
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          icon={Plus}
          onClick={add}
          className="mt-1 border-dashed"
        >
          Add stage
        </Button>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line-soft px-6 py-4">
        <p className="text-[13px] text-danger">{error}</p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={guardedClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSave}>
            {saving ? 'Saving…' : 'Save stages'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
