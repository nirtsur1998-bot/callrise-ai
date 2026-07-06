import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Building2, PhoneCall, ListPlus, AlertTriangle } from 'lucide-react'
import { useContacts } from '@renderer/features/contacts/useContacts'
import { buildContactStats, daysSinceLastCall } from '@renderer/features/contacts/contactStats'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import type { CallSummary } from '@renderer/features/calls/types'
import type { Contact } from '@renderer/features/contacts/types'
import { useDeals } from './useDeals'
import { useDealStages } from './useDealStages'
import { isDealStale, createFollowUpTask } from './staleness'
import { formatValue } from './format'
import type { Deal } from './types'

interface FollowUpDigestProps {
  onOpenDeal: (dealId: string) => void
}

interface FlaggedDeal {
  deal: Deal
  contact: Contact | undefined
  days: number // Infinity = never called
}

/** Every flagged deal across the whole pipeline, in one place, most overdue
 *  first — so nothing goes stale just because it's buried in a board column. */
export function FollowUpDigest({ onOpenDeal }: FollowUpDigestProps): React.JSX.Element {
  const { deals, loading: dealsLoading } = useDeals()
  const { stages, loading: stagesLoading } = useDealStages()
  const { contacts } = useContacts()
  const { settings } = useAppSettings()
  const { staleFollowUpEnabled, staleAfterDays } = settings.crm
  const [calls, setCalls] = useState<CallSummary[]>([])

  useEffect(() => {
    let active = true
    void window.api.calls.list().then((list) => {
      if (active) setCalls(list)
    })
    return () => {
      active = false
    }
  }, [])

  const loading = dealsLoading || stagesLoading

  const flagged = useMemo<FlaggedDeal[]>(() => {
    const contactStats = buildContactStats(calls)
    const stageById = new Map(stages.map((s) => [s.id, s]))
    const contactById = new Map(contacts.map((c) => [c.id, c]))

    return deals
      .filter((d) =>
        isDealStale(
          stageById.get(d.stageId),
          contactStats.get(d.contactId)?.lastCallAt,
          staleFollowUpEnabled,
          staleAfterDays
        )
      )
      .map((deal) => ({
        deal,
        contact: contactById.get(deal.contactId),
        days: daysSinceLastCall(contactStats.get(deal.contactId)?.lastCallAt)
      }))
      .sort((a, b) => b.days - a.days)
  }, [deals, stages, contacts, calls, staleFollowUpEnabled, staleAfterDays])

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex items-baseline gap-2.5">
        <h2 className="text-lg font-semibold tracking-tight">Needs follow-up</h2>
        <span className="text-[13px] text-faint">
          {flagged.length} deal{flagged.length === 1 ? '' : 's'}
        </span>
      </div>
      <p className="mb-5 text-[13px] text-faint">
        Every open deal whose contact has gone quiet longer than your Settings → CRM threshold, most
        overdue first.
      </p>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-faint">Loading…</div>
      ) : !staleFollowUpEnabled ? (
        <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
          Follow-up flagging is off. Turn it on in Settings → CRM to see this list.
        </p>
      ) : flagged.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
            <CheckCircle2 className="h-6 w-6 text-emerald-300" strokeWidth={1.75} />
          </div>
          <h3 className="text-lg font-semibold">Nothing needs a follow-up</h3>
          <p className="mt-1.5 max-w-xs text-sm text-muted">
            Every open deal has had a call within your threshold. Nice work staying in touch.
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {flagged.map(({ deal, contact, days }) => (
            <FollowUpRow
              key={deal.id}
              deal={deal}
              contact={contact}
              days={days}
              onOpen={() => onOpenDeal(deal.id)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function formatOverdue(days: number): string {
  if (!Number.isFinite(days)) return 'No calls yet'
  const whole = Math.floor(days)
  return `${whole} day${whole === 1 ? '' : 's'} since last call`
}

interface FollowUpRowProps {
  deal: Deal
  contact: Contact | undefined
  days: number
  onOpen: () => void
}

function FollowUpRow({ deal, contact, days, onOpen }: FollowUpRowProps): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(false)
  const value = formatValue(deal.value)

  const handleCreate = async (): Promise<void> => {
    setCreating(true)
    try {
      await createFollowUpTask(deal, contact?.name)
      setCreated(true)
    } finally {
      setCreating(false)
    }
  }

  return (
    <li className="flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-medium">{deal.title}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
          <span className="flex items-center gap-1">
            <Building2 className="h-3 w-3" /> {contact?.name ?? 'Unknown contact'}
            {contact?.company ? ` · ${contact.company}` : ''}
          </span>
          {value && <span className="font-medium text-ink">{value}</span>}
          <span className="flex items-center gap-1 font-medium text-amber-300">
            <AlertTriangle className="h-3 w-3" /> {formatOverdue(days)}
          </span>
        </div>
      </button>

      <div className="flex shrink-0 items-center gap-2">
        {created ? (
          <span className="flex items-center gap-1 text-[12px] font-medium text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" /> Task created
          </span>
        ) : (
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink disabled:opacity-50"
          >
            <ListPlus className="h-3.5 w-3.5" /> {creating ? 'Creating…' : 'Create task'}
          </button>
        )}
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
        >
          <PhoneCall className="h-3.5 w-3.5" /> Open
        </button>
      </div>
    </li>
  )
}
