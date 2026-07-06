import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Contact as ContactIcon,
  Building2,
  Mail,
  Phone,
  Pencil,
  Trash2,
  Search,
  Hash,
  CalendarClock,
  PhoneCall
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { flagEmoji, countryDial } from '@renderer/lib/countries'
import { TONE_TEXT } from '@renderer/features/coaching/meta'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import { useDeals } from '@renderer/features/deals/useDeals'
import { useDealStages } from '@renderer/features/deals/useDealStages'
import { contactsWithOpenDeals, isContactStale } from '@renderer/features/deals/staleness'
import { StaleBadge } from '@renderer/features/deals/StaleBadge'
import type { CallSummary } from '@renderer/features/calls/types'
import { useContacts } from './useContacts'
import { ContactFormDialog, type ContactFormValues } from './ContactFormDialog'
import { ContactDetail } from './ContactDetail'
import { buildContactStats, recencyTone, formatRelative, type ContactStats } from './contactStats'
import type { Contact } from './types'

type SortMode = 'recent' | 'name'

function formatRegisteredDate(value: string | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

interface ContactsViewProps {
  /** Deep-link from the follow-up digest: open this contact on mount. */
  initialViewId?: string | null
  /** Called once the initial selection above has been applied, so the parent
   *  can clear it (otherwise a later plain visit would reopen the same contact). */
  onInitialViewConsumed?: () => void
}

export function ContactsView({
  initialViewId = null,
  onInitialViewConsumed
}: ContactsViewProps = {}): React.JSX.Element {
  const { contacts, loading, create, update, remove } = useContacts()
  const { deals } = useDeals()
  const { stages } = useDealStages()
  const { settings } = useAppSettings()
  const { staleFollowUpEnabled, staleAfterDays } = settings.crm
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Contact | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(initialViewId)

  const consumedRef = useRef(false)
  useEffect(() => {
    if (initialViewId && !consumedRef.current) {
      consumedRef.current = true
      onInitialViewConsumed?.()
    }
  }, [initialViewId, onInitialViewConsumed])

  useEffect(() => {
    // Read-only glance data for the list ("3 calls · last week") — reuses the
    // same call summaries the Contact detail view fetches in full.
    let active = true
    void window.api.calls.list().then((list) => {
      if (active) setCalls(list)
    })
    return () => {
      active = false
    }
  }, [])

  const stats = useMemo(() => buildContactStats(calls), [calls])
  const openDealContactIds = useMemo(() => contactsWithOpenDeals(deals, stages), [deals, stages])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? contacts.filter((c) =>
          [c.name, c.company, c.email, c.phone, c.cid].some((f) => f?.toLowerCase().includes(q))
        )
      : contacts
    return [...filtered].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      const aLast = stats.get(a.id)?.lastCallAt
      const bLast = stats.get(b.id)?.lastCallAt
      if (aLast && bLast) return bLast.localeCompare(aLast)
      if (aLast) return -1 // contacts with call history surface first
      if (bLast) return 1
      return a.name.localeCompare(b.name) // no history on either side — fall back to A–Z
    })
  }, [contacts, query, sort, stats])

  const viewing = viewingId ? contacts.find((c) => c.id === viewingId) : undefined

  if (viewing) {
    return (
      <>
        <ContactDetail
          contact={viewing}
          hasOpenDeal={openDealContactIds.has(viewing.id)}
          staleFollowUpEnabled={staleFollowUpEnabled}
          staleAfterDays={staleAfterDays}
          onBack={() => setViewingId(null)}
          onEdit={() => setEditing(viewing)}
        />
        {editing && (
          <ContactFormDialog
            contact={editing}
            onClose={() => setEditing(null)}
            onSubmit={async (values: ContactFormValues) => {
              await update(editing.id, values)
              setEditing(null)
            }}
          />
        )}
      </>
    )
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* Header */}
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">Contacts</h2>
          <span className="text-[13px] text-faint">{contacts.length} total</span>
        </div>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
        >
          <Plus className="h-4 w-4" /> Add contact
        </button>
      </div>
      <p className="mb-5 text-[13px] text-faint">
        The people you sell to — your call history with each one lives here.
      </p>

      {contacts.length > 0 && (
        <div className="mb-4 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, company, email, or phone"
              className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-faint transition focus:border-accent focus:outline-none"
            />
          </div>
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line p-0.5">
            {(['recent', 'name'] as SortMode[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                className={cn(
                  'rounded-md px-2.5 py-1.5 text-xs font-medium transition',
                  sort === s ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink'
                )}
              >
                {s === 'recent' ? 'Recent' : 'A–Z'}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading ? (
        <ListSkeleton />
      ) : contacts.length === 0 ? (
        <EmptyAll onAdd={() => setAdding(true)} />
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
          No contacts match “{query}”.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((contact) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              stats={stats.get(contact.id)}
              stale={isContactStale(
                openDealContactIds.has(contact.id),
                stats.get(contact.id)?.lastCallAt,
                staleFollowUpEnabled,
                staleAfterDays
              )}
              onView={() => setViewingId(contact.id)}
              onEdit={() => setEditing(contact)}
              onDelete={() => void remove(contact.id)}
            />
          ))}
        </ul>
      )}

      {adding && (
        <ContactFormDialog
          onClose={() => setAdding(false)}
          onSubmit={async (values: ContactFormValues) => {
            await create(values)
            setAdding(false)
          }}
        />
      )}
      {editing && (
        <ContactFormDialog
          contact={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (values: ContactFormValues) => {
            await update(editing.id, values)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

interface ContactRowProps {
  contact: Contact
  stats: ContactStats | undefined
  stale: boolean
  onView: () => void
  onEdit: () => void
  onDelete: () => void
}

function ContactRow({
  contact,
  stats,
  stale,
  onView,
  onEdit,
  onDelete
}: ContactRowProps): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const registered = formatRegisteredDate(contact.registeredAt)
  const dial = countryDial(contact.phoneCountry)
  const tone = recencyTone(stats?.lastCallAt)

  return (
    <li>
      <div className="group flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
          {contact.name.slice(0, 1).toUpperCase()}
        </div>

        <button type="button" onClick={onView} className="min-w-0 flex-1 text-left">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-sm font-medium">
              {contact.country && (
                <span className="mr-1.5" title={contact.country}>
                  {flagEmoji(contact.country)}
                </span>
              )}
              {contact.name}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {stale && <StaleBadge />}
              <span
                className={cn('flex items-center gap-1 text-[11px] font-medium', TONE_TEXT[tone])}
              >
                <PhoneCall className="h-3 w-3" />
                {stats
                  ? `${stats.callCount} call${stats.callCount === 1 ? '' : 's'} · ${formatRelative(stats.lastCallAt as string)}`
                  : 'No calls yet'}
              </span>
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
            {contact.company && (
              <span className="flex items-center gap-1">
                <Building2 className="h-3 w-3" /> {contact.company}
              </span>
            )}
            {contact.cid && (
              <span className="flex items-center gap-1">
                <Hash className="h-3 w-3" /> {contact.cid}
              </span>
            )}
            {contact.email && (
              <span className="flex items-center gap-1">
                <Mail className="h-3 w-3" /> {contact.email}
              </span>
            )}
            {contact.phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3" /> {dial ? `${dial} ` : ''}
                {contact.phone}
              </span>
            )}
            {registered && (
              <span className="flex items-center gap-1">
                <CalendarClock className="h-3 w-3" /> Since {registered}
              </span>
            )}
          </div>
          {contact.notes && <p className="mt-1.5 text-[12px] text-muted">{contact.notes}</p>}
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {confirm ? (
            <>
              <button
                type="button"
                onClick={onDelete}
                className="rounded-lg bg-rose-500/20 px-2.5 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-500/30"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirm(false)}
                className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:text-ink"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onEdit}
                title="Edit contact"
                className="grid h-8 w-8 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-canvas hover:text-ink group-hover:opacity-100"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setConfirm(true)}
                title="Delete contact"
                className={cn(
                  'grid h-8 w-8 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-canvas hover:text-rose-300 group-hover:opacity-100'
                )}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </li>
  )
}

function ListSkeleton(): React.JSX.Element {
  return (
    <ul className="space-y-2.5">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5"
        >
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-elevated" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-32 animate-pulse rounded bg-elevated" />
            <div className="h-2.5 w-48 animate-pulse rounded bg-elevated" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function EmptyAll({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
        <ContactIcon className="h-6 w-6 text-faint" strokeWidth={1.75} />
      </div>
      <h3 className="text-lg font-semibold">No contacts yet</h3>
      <p className="mt-1.5 max-w-xs text-sm text-muted">
        Add the people you sell to, so your calls can build a history with each one.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
      >
        <Plus className="h-4 w-4" /> Add contact
      </button>
    </div>
  )
}
