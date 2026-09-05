import { useCallback, useEffect, useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import type { LinkSuggestions } from './types'

/**
 * M34 — "Link all N coached calls", for every closed deal that has some.
 *
 * The founder's board said 4 won while the gate saw zero: the deals were
 * closed, their contacts' coached calls existed, and nothing was linked.
 * Twelve clicks across four pages is the friction that means it never gets
 * done. So, the backfill's lesson applied here: the WHOLE set up front with a
 * count, one click per deal, one click for all of them, nothing reorders.
 *
 * Records only. Each offered call already belongs to that deal's contact and
 * to no deal; the deal already has its outcome. Nothing here is a judgment
 * and nothing here reads the outcome gate.
 */
export function LinkCallsDialog({
  onClose,
  onChanged
}: {
  onClose: () => void
  onChanged?: () => void
}): React.JSX.Element {
  const [set, setSet] = useState<LinkSuggestions | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // dealId or 'all'
  const [linkedByDeal, setLinkedByDeal] = useState<Record<string, number>>({})
  const [order, setOrder] = useState<string[]>([]) // rows never reorder: fixed at first load

  // A linked row drops out of the live set, so its title has to be remembered
  // from the set that had it — the first version showed "Deal" after linking,
  // seen on the founder's real board.
  const [titleById, setTitleById] = useState<Record<string, string>>({})
  const remember = useCallback((s: LinkSuggestions): void => {
    setTitleById((m) => {
      const next = { ...m }
      for (const d of s.deals) next[d.dealId] = d.dealTitle
      return next
    })
  }, [])

  const load = useCallback(async (): Promise<void> => {
    const s = await window.api.dealBackfill.linkSuggestions()
    remember(s)
    setSet(s)
    setOrder((prev) => (prev.length ? prev : s.deals.map((d) => d.dealId)))
  }, [remember])
  useEffect(() => {
    void load()
  }, [load])

  const linkOne = async (dealId: string, offered: number): Promise<void> => {
    setBusy(dealId)
    try {
      const r = await window.api.dealBackfill.linkCoachedCalls(dealId)
      setLinkedByDeal((m) => ({ ...m, [dealId]: r.ok ? r.linked : 0 }))
      setSet(r.suggestions)
      if (r.ok && r.linked !== offered) {
        // The offer and the result differ (a call claimed elsewhere meanwhile,
        // or a write failed). Say the real number — see the backfill row's
        // "linkedCallCount, NOT callCount" rule.
      }
    } finally {
      setBusy(null)
      onChanged?.()
    }
  }

  const linkAll = async (): Promise<void> => {
    if (!set) return
    setBusy('all')
    try {
      const before = Object.fromEntries(set.deals.map((d) => [d.dealId, d.coachedCallIds.length]))
      const r = await window.api.dealBackfill.linkAllSuggested()
      const stillOffered = new Set(r.suggestions.deals.map((d) => d.dealId))
      setLinkedByDeal((m) => {
        const next = { ...m }
        for (const id of Object.keys(before)) if (!stillOffered.has(id)) next[id] = before[id]
        return next
      })
      setSet(r.suggestions)
    } finally {
      setBusy(null)
      onChanged?.()
    }
  }

  const rows = order.map((id) => ({
    id,
    live: set?.deals.find((d) => d.dealId === id),
    linked: linkedByDeal[id]
  }))
  const remaining = set?.totalCalls ?? 0
  const dealsRemaining = set?.deals.length ?? 0

  return (
    <Modal onClose={onClose} title="Link coached calls to closed deals" size="xl" className="flex max-h-[85vh] flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <p className="max-w-3xl text-[13px] leading-relaxed text-muted">
          These deals are already closed, and their contacts already have coached calls that belong to
          no deal. Until a call is linked, the deal cannot be counted — the board says won, the
          analysis sees nothing.{' '}
          <strong className="font-medium text-ink">Linking is bookkeeping, not a judgment:</strong>{' '}
          the call already belongs to that person, and the outcome is already recorded.
        </p>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-line-soft bg-surface px-3.5 py-3">
          <span className="text-[13px] font-medium text-ink" data-testid="link-summary">
            {set === null
              ? 'Loading…'
              : remaining === 0
                ? 'Nothing left to link.'
                : `${remaining} coached call${remaining === 1 ? '' : 's'} across ${dealsRemaining} closed deal${dealsRemaining === 1 ? '' : 's'}`}
          </span>
          {remaining > 0 && (
            <Button icon={Link2} onClick={() => void linkAll()} disabled={busy !== null}>
              Link all {remaining}
            </Button>
          )}
        </div>

        {set && rows.length === 0 ? (
          <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
            Every closed deal already has a coached call linked, or its contact has none to offer.
          </p>
        ) : (
          <ul className="-mx-1 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1">
            {rows.map(({ id, live, linked }) => (
              <li
                key={id}
                data-testid="link-row"
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-line-soft bg-surface px-3 py-2.5"
              >
                <div className="min-w-[13rem] flex-1">
                  <div className="flex items-center gap-1.5">
                    {typeof linked === 'number' && <Check className="h-3.5 w-3.5 shrink-0 text-positive" />}
                    <span className="truncate text-[13px] font-medium text-ink">
                      {live?.dealTitle ?? titleById[id] ?? 'Deal'}
                    </span>
                    {live?.contactName && (
                      <span className="truncate text-[12px] text-faint">· {live.contactName}</span>
                    )}
                    {live?.stageLabel && (
                      <span className="rounded-full bg-elevated px-2 py-0.5 text-[11px] text-muted">
                        {live.stageLabel}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-faint">
                    {typeof linked === 'number'
                      ? `Linked ${linked} call${linked === 1 ? '' : 's'}.`
                      : live
                        ? `${live.coachedCallIds.length} coached call${live.coachedCallIds.length === 1 ? '' : 's'} not on any deal`
                        : 'Already linked.'}
                  </p>
                </div>
                {live && typeof linked !== 'number' && (
                  <Button
                    variant="secondary"
                    icon={Link2}
                    disabled={busy !== null}
                    onClick={() => void linkOne(id, live.coachedCallIds.length)}
                  >
                    Link {live.coachedCallIds.length}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex shrink-0 justify-end border-t border-line-soft pt-3">
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}
