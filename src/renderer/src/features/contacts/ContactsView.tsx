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
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { SkeletonRows } from '@renderer/components/Skeleton'
import { SegmentedControl } from '@renderer/components/SegmentedControl'
import { EmptyState } from '@renderer/components/EmptyState'
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
import { formatDateOnly } from '@renderer/lib/dateOnly'

type SortMode = 'recent' | 'name'

// registeredAt is DATE-ONLY — formatDateOnly avoids the UTC-midnight parse
// that displayed the previous day for users west of UTC.
const formatRegisteredDate = formatDateOnly

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
  const [deleteBlocked, setDeleteBlocked] = useState<string | null>(null)

  const handleDelete = async (contact: Contact): Promise<void> => {
    const ok = await remove(contact.id)
    setDeleteBlocked(ok ? null : contact.name)
  }

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
      <PageHeader
        title="Contacts"
        count={
          query.trim() ? `${visible.length} of ${contacts.length}` : `${contacts.length} total`
        }
        subtitle="The people you sell to — your call history with each one lives here."
        actions={
          <Button onClick={() => setAdding(true)} icon={Plus}>
            Add contact
          </Button>
        }
      />

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
          <SegmentedControl
            options={[
              { id: 'recent', label: 'Recent' },
              { id: 'name', label: 'A-Z' }
            ]}
            value={sort}
            onChange={setSort}
            className="shrink-0"
          />
        </div>
      )}

      {deleteBlocked && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3">
          <p className="text-[13px] text-ink">
            {deleteBlocked} still has deals on the Deals screen — delete or re-assign those deals
            first, then delete the contact.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDeleteBlocked(null)}
            className="shrink-0 border-0 text-[13px]"
          >
            Dismiss
          </Button>
        </div>
      )}

      {loading ? (
        <SkeletonRows rows={3} />
      ) : contacts.length === 0 ? (
        <EmptyAll onAdd={() => setAdding(true)} />
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
          No contacts match “{query}”.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((contact, index) => (
            <ContactRow
              key={contact.id}
              contact={contact}
              index={index}
              stats={stats.get(contact.id)}
              stale={isContactStale(
                openDealContactIds.has(contact.id),
                stats.get(contact.id)?.lastCallAt,
                staleFollowUpEnabled,
                staleAfterDays,
                contact.createdAt
              )}
              onView={() => setViewingId(contact.id)}
              onEdit={() => setEditing(contact)}
              onDelete={() => void handleDelete(contact)}
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
  index: number
  stats: ContactStats | undefined
  stale: boolean
  onView: () => void
  onEdit: () => void
  onDelete: () => void
}

function ContactRow({
  contact,
  index,
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
    <li className="stagger-item" style={{ animationDelay: `${Math.min(index, 8) * 35}ms` }}>
      <div className="group flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
          {contact.name.slice(0, 1).toUpperCase()}
        </div>

        <button type="button" onClick={onView} className="min-w-0 flex-1 text-left">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-sm font-medium" title={contact.name}>
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
          {contact.notes && (
            <p className="mt-1.5 line-clamp-1 break-words text-[12px] text-muted">
              {contact.notes}
            </p>
          )}
        </button>

        <div className="flex shrink-0 items-center gap-1">
          {confirm ? (
            <>
              <Button variant="danger" size="sm" onClick={onDelete}>
                Delete
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <IconButton
                icon={Pencil}
                label="Edit contact"
                onClick={onEdit}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              />
              <IconButton
                icon={Trash2}
                label="Delete contact"
                variant="danger"
                onClick={() => setConfirm(true)}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              />
            </>
          )}
        </div>
      </div>
    </li>
  )
}

function EmptyAll({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <EmptyState
      icon={ContactIcon}
      title="No contacts yet"
      description="Add the people you sell to, so your calls can build a history with each one."
      action={{ label: 'Add contact', onClick: onAdd, icon: Plus }}
      titleAs="h2"
    />
  )
}
