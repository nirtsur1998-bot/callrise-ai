import { useEffect, useState } from 'react'
import { MessageSquareQuote, Pencil } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { DealStageKind } from './types'

/**
 * The outcome reason on the DEAL DETAIL page — for closed deals only.
 *
 * ── THIS EXISTS BECAUSE THE APP PROMISED IT ──────────────────────────────
 *
 * The retired-notice copy shipped saying *"You can still add a reason to any
 * deal from its detail page whenever you want to"* — and the detail page had
 * no such thing. A shipped claim of a nonexistent capability, in the milestone
 * whose whole subject is the app not claiming what it has not got. Found by
 * grepping for `outcomeReason` consumers and finding only the writer.
 *
 * It also closes the second path to a closed deal: the board's banner fires on
 * a chevron move, but a deal closed through the EDIT DIALOG (the detail page's
 * only stage control) never sees that banner — it lands back here. So here is
 * where the reason can be added.
 *
 * Same honesty rules as the banner: optional in the strongest sense, empty is
 * a legitimate final state, and an empty save is treated as "no reason", never
 * as a blank string pretending to be one.
 */

interface OutcomeReasonSectionProps {
  dealId: string
  kind: Exclude<DealStageKind, 'open'>
  reason?: string
  onChanged: () => void
}

const LEAD: Record<Exclude<DealStageKind, 'open'>, string> = {
  won: 'Why it was won',
  lost: 'Why it was lost',
  'went-quiet': 'Where it went quiet'
}

export function OutcomeReasonSection({
  dealId,
  kind,
  reason,
  onChanged
}: OutcomeReasonSectionProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(reason ?? '')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  // A refetched deal (risk run, sync) must not clobber an edit in progress —
  // only re-seed the draft while the field is closed.
  useEffect(() => {
    if (!editing) setText(reason ?? '')
  }, [reason, editing])

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(false)
    try {
      const trimmed = text.trim()
      // Empty clears rather than storing '' — "there was no reason" and "not
      // answered" are different claims, and the analysis must only ever see
      // the second.
      //
      // deals.update resolves NULL on failure rather than rejecting (missing
      // deal, disk error). Treating that as success closed the editor and
      // silently discarded the typed text — workflow finding. Null keeps the
      // editor open with the draft intact and says so.
      const saved = await window.api.deals.update(dealId, { outcomeReason: trimmed || null })
      if (!saved) {
        setSaveError(true)
        return
      }
      onChanged()
      setEditing(false)
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-4 rounded-xl border border-line-soft bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <MessageSquareQuote className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">{LEAD[kind]}</h3>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex items-center gap-1.5 text-[12px] text-muted transition-colors hover:text-ink"
          >
            <Pencil className="h-3.5 w-3.5" />
            {reason ? 'Edit' : 'Add'}
          </button>
        )}
      </div>

      {editing ? (
        <div className="mt-2">
        <div className="flex items-center gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              if (e.key === 'Escape') {
                setText(reason ?? '')
                setEditing(false)
              }
            }}
            maxLength={500}
            autoFocus
            placeholder="In your own words — or leave it blank"
            className={cn(
              'h-8 flex-1 rounded-md border border-line bg-elevated px-2.5 text-[13px] text-ink',
              'placeholder:text-faint focus:border-line-strong focus:outline-none'
            )}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="h-8 shrink-0 rounded-md bg-accent-soft px-3 text-[12px] font-medium text-ink transition-colors hover:bg-elevated"
          >
            Save
          </button>
        </div>
        {saveError && (
          <p className="mt-1.5 text-[12px] text-danger">
            Couldn&apos;t save — your text is still here. Try again, or copy it somewhere safe.
          </p>
        )}
        </div>
      ) : reason ? (
        <p className="mt-1.5 text-sm text-muted">{reason}</p>
      ) : (
        <p className="mt-1.5 text-[13px] text-faint">
          Nothing recorded — that&apos;s fine. A guessed reason is worse than a blank one.
        </p>
      )}
    </div>
  )
}
