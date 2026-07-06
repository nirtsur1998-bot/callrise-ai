import { useState } from 'react'
import { X, Plus, ArrowUp, ArrowDown, Trash2 } from 'lucide-react'
import type { DealStage, DealStageKind } from './types'

const KIND_LABEL: Record<DealStageKind, string> = { open: 'Open', won: 'Won', lost: 'Lost' }
const KIND_ORDER: DealStageKind[] = ['open', 'won', 'lost']

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
        aria-label="Manage stages"
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between gap-4 border-b border-line-soft px-6 py-4">
          <h2 className="text-sm font-semibold">Manage stages</h2>
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
                className="min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink placeholder:text-faint transition focus:border-accent focus:outline-none"
              />
              <select
                value={stage.kind}
                onChange={(e) => update(i, { kind: e.target.value as DealStageKind })}
                className="rounded-lg border border-line bg-canvas px-2 py-2 text-xs text-ink transition focus:border-accent focus:outline-none [color-scheme:dark]"
              >
                {KIND_ORDER.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title="Move up"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink disabled:opacity-30"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === draft.length - 1}
                title="Move down"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink disabled:opacity-30"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => remove(i)}
                title="Remove stage"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={add}
            className="mt-1 flex items-center gap-1.5 rounded-lg border border-dashed border-line px-3 py-2 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" /> Add stage
          </button>
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
              {saving ? 'Saving…' : 'Save stages'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
