import { useCallback, useEffect, useState } from 'react'
import { PhoneCall, Link2, Unlink, BarChart3 } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { CallSummary } from '@renderer/features/calls/types'

/**
 * "Which calls belong to this deal?" — the deal-side half of the call↔deal
 * link, and the other entry point onto the same single field.
 *
 * ── IT IS A QUERY, NOT A SECOND LIST ─────────────────────────────────────
 *
 * This reads `call.dealId === deal.id`. It does not store a `callIds` array on
 * the deal. That is deliberate and it is the whole design: two stored lists
 * pointing at each other WILL disagree — one write succeeds, the other fails,
 * a sync pulls one side, and now the call thinks it belongs to deal A while
 * deal B still lists it. There is no reconciliation code to write here because
 * there is only ever one fact.
 *
 * ── WHY IT REPLACES A LIST THAT LOOKED FINE ──────────────────────────────
 *
 * The deal detail already had a "Call history" section — but it showed the
 * *contact's* calls (`useContactCallHistory(deal.contactId)`). For a contact
 * with two deals, both deals showed an identical list, and neither was wrong
 * about anything it claimed; it simply was not answering the question its
 * heading asked. That ambiguity is exactly what `dealId` exists to remove, so
 * showing it here unchanged would have left the new field invisible on the one
 * screen where it matters most.
 *
 * The contact's other calls are still reachable — as *candidates to link*,
 * which is what they actually are.
 */

interface DealCallsSectionProps {
  dealId: string
  contactId: string
  contactName?: string
  /** Bumped by the parent when something else changes the underlying calls. */
  refreshKey?: number
}

interface Split {
  linked: CallSummary[]
  candidates: CallSummary[]
}

export function DealCallsSection({
  dealId,
  contactId,
  contactName,
  refreshKey = 0
}: DealCallsSectionProps): React.JSX.Element {
  const [split, setSplit] = useState<Split | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const all = await window.api.calls.list()
    setSplit({
      linked: all
        .filter((c) => c.dealId === dealId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      // The contact's OWN calls that belong to no deal yet. Deliberately not
      // "every unlinked call": offering all 96 contactless calls here would be
      // a haystack, and picking wrong from a haystack is how a guess gets
      // recorded as a decision.
      candidates: all
        .filter((c) => c.contactId === contactId && !c.dealId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    })
  }, [dealId, contactId])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const setLink = async (callId: string, next: string | null): Promise<void> => {
    setBusyId(callId)
    try {
      await window.api.calls.setDeal(callId, next)
      await load()
    } finally {
      setBusyId(null)
    }
  }

  const linked = split?.linked ?? []
  const candidates = split?.candidates ?? []
  const measurable = linked.filter((c) => c.hasCoaching).length

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <PhoneCall className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold">Calls on this deal</h3>
        {split && <span className="text-[11px] text-faint">{linked.length}</span>}
      </div>

      {split && linked.length > 0 && (
        // Says what the deal is worth TO THE ANALYSIS, in the same place the
        // linking happens — so "why isn't this deal counting?" is answerable
        // without leaving the screen.
        <p className="mb-2.5 flex items-center gap-1.5 text-[12px] text-faint">
          <BarChart3 className="h-3.5 w-3.5" />
          {measurable === 0
            ? 'None of these carry coaching metrics yet, so this deal cannot be compared.'
            : `${measurable} of ${linked.length} carr${measurable === 1 ? 'ies' : 'y'} coaching metrics — enough for this deal to count.`}
        </p>
      )}

      {!split ? (
        <p className="rounded-xl border border-line-soft bg-surface px-4 py-6 text-center text-sm text-muted">
          Loading…
        </p>
      ) : linked.length === 0 ? (
        <p className="rounded-xl border border-line-soft bg-surface px-4 py-6 text-center text-sm text-muted">
          No calls linked to this deal yet. Link one below, or from the call itself.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {linked.map((call) => (
            <CallRow
              key={call.id}
              call={call}
              busy={busyId === call.id}
              action="unlink"
              onClick={() => void setLink(call.id, null)}
            />
          ))}
        </ul>
      )}

      {candidates.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-[12px] font-medium text-muted">
            Other calls with {contactName ?? 'this contact'}, not on any deal
          </p>
          <ul className="space-y-1.5">
            {candidates.map((call) => (
              <CallRow
                key={call.id}
                call={call}
                busy={busyId === call.id}
                action="link"
                onClick={() => void setLink(call.id, dealId)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function CallRow({
  call,
  busy,
  action,
  onClick
}: {
  call: CallSummary
  busy: boolean
  action: 'link' | 'unlink'
  onClick: () => void
}): React.JSX.Element {
  const when = new Date(call.createdAt)
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-line-soft bg-surface px-3 py-2">
      <div className="min-w-0">
        <p className="truncate text-[13px] text-ink">{call.title}</p>
        <p className="text-[11px] text-faint">
          {Number.isNaN(when.getTime())
            ? ''
            : when.toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric'
              })}
          {call.hasCoaching ? ' · coached' : ' · not coached'}
        </p>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors',
          action === 'link'
            ? 'border-line text-muted hover:border-line-strong hover:text-ink'
            : 'border-line text-faint hover:border-danger hover:text-danger'
        )}
      >
        {action === 'link' ? <Link2 className="h-3.5 w-3.5" /> : <Unlink className="h-3.5 w-3.5" />}
        {action === 'link' ? 'Link' : 'Unlink'}
      </button>
    </li>
  )
}
