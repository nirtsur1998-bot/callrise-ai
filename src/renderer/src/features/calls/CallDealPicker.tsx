import { useEffect, useMemo, useState } from 'react'
import { Briefcase, Link2 } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { fieldClass } from '@renderer/components/field'
import type { Deal, DealStage } from '@renderer/features/deals/types'

/**
 * "Which pursuit does this call belong to?" — the call-side half of the
 * call↔deal link.
 *
 * ── WHY THIS EXISTS AT ALL, GIVEN CALLS ALREADY LINK TO CONTACTS ─────────
 *
 * Because `call.contactId → deal.contactId` is not a link, it is a guess with
 * good odds. It is **optional** (96 of 163 calls on the founder's machine have
 * no contact at all) and **ambiguous** (a contact with two deals gives no way
 * to say which one a call belongs to). A wrong attribution does not announce
 * itself — it quietly moves one call's coaching metrics into the wrong deal's
 * column, and every later comparison inherits it.
 *
 * ── IT OFFERS, IT NEVER RECORDS ──────────────────────────────────────────
 *
 * When the call's contact has exactly ONE open deal, that is an unambiguous
 * candidate and the picker says so with a one-click chip. It still requires
 * the click. Auto-linking on an unambiguous-looking match is how a guess
 * becomes indistinguishable from a decision — and the whole point of this
 * field is that the two stay distinguishable.
 */

interface CallDealPickerProps {
  callId: string
  /** The deal currently linked to this call, if any. */
  value?: string
  /** The call's linked contact, used to sort and to find the safe suggestion. */
  contactId?: string
  onChanged: () => void | Promise<void>
}

export function CallDealPicker({
  callId,
  value,
  contactId,
  onChanged
}: CallDealPickerProps): React.JSX.Element | null {
  const [deals, setDeals] = useState<Deal[] | null>(null)
  const [stages, setStages] = useState<DealStage[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([window.api.deals.list(), window.api.dealStages.get()]).then(([d, s]) => {
      if (!active) return
      setDeals(d)
      setStages(s)
    })
    return () => {
      active = false
    }
  }, [])

  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages])

  // This contact's deals first, then everyone else's. A call is nearly always
  // about its own contact's pursuit, and putting those first is the difference
  // between picking and hunting — but the rest stay reachable, because a call
  // genuinely can belong to a deal filed under someone else at the same account.
  const ordered = useMemo(() => {
    if (!deals) return []
    const mine = deals.filter((d) => d.contactId === contactId)
    const others = deals.filter((d) => d.contactId !== contactId)
    return [...mine, ...others]
  }, [deals, contactId])

  /**
   * The one case where a suggestion is safe to surface: the call has a
   * contact, that contact has exactly one OPEN deal, and this call is not
   * linked yet. Two open deals is the ambiguity — no chip, use the list.
   */
  const suggestion = useMemo(() => {
    if (value || !contactId || !deals) return null
    const open = deals.filter(
      (d) => d.contactId === contactId && stageById.get(d.stageId)?.kind === 'open'
    )
    return open.length === 1 ? open[0] : null
  }, [value, contactId, deals, stageById])

  const link = async (dealId: string | null): Promise<void> => {
    setBusy(true)
    try {
      await window.api.calls.setDeal(callId, dealId)
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  // Nothing to link to yet. Rendering an empty select would be a control that
  // cannot do anything, which reads as broken rather than as not-applicable.
  if (deals !== null && deals.length === 0) return null

  return (
    <div className="mt-3 border-t border-line-soft pt-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Briefcase className="h-3.5 w-3.5 text-faint" />
        <span className="text-[12px] font-medium text-muted">Deal</span>
      </div>

      <select
        value={value ?? ''}
        disabled={busy || deals === null}
        onChange={(e) => void link(e.target.value || null)}
        className={cn(fieldClass, 'h-9 text-[13px]')}
        aria-label="Link this call to a deal"
      >
        <option value="">Not linked to a deal</option>
        {ordered.map((d) => (
          <option key={d.id} value={d.id}>
            {d.title}
            {stageById.get(d.stageId) ? ` · ${stageById.get(d.stageId)!.label}` : ''}
          </option>
        ))}
      </select>

      {suggestion && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void link(suggestion.id)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-[12px] text-muted transition-colors hover:border-line-strong hover:text-ink"
        >
          <Link2 className="h-3.5 w-3.5" />
          Link to <span className="font-medium text-ink">{suggestion.title}</span>
        </button>
      )}

      <p className="mt-1.5 text-[11px] text-faint">
        {value
          ? "This call's coaching metrics count toward that deal's outcome."
          : 'Only linked calls count toward outcome tracking. Nothing is linked automatically.'}
      </p>
    </div>
  )
}
