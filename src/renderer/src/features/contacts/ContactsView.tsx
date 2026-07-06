import { useMemo, useState } from 'react'
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
  CalendarClock
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { flagEmoji, countryDial } from '@renderer/lib/countries'
import { useContacts } from './useContacts'
import { ContactFormDialog, type ContactFormValues } from './ContactFormDialog'
import { ContactDetail } from './ContactDetail'
import type { Contact } from './types'

function formatRegisteredDate(value: string | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function ContactsView(): React.JSX.Element {
  const { contacts, loading, create, update, remove } = useContacts()
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Contact | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter((c) =>
      [c.name, c.company, c.email, c.phone, c.cid].some((f) => f?.toLowerCase().includes(q))
    )
  }, [contacts, query])

  const viewing = viewingId ? contacts.find((c) => c.id === viewingId) : undefined

  if (viewing) {
    return (
      <>
        <ContactDetail
          contact={viewing}
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
        <div className="relative mb-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, company, email, or phone"
            className="w-full rounded-lg border border-line bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-faint transition focus:border-accent focus:outline-none"
          />
        </div>
      )}

      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-faint">Loading…</div>
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
  onView: () => void
  onEdit: () => void
  onDelete: () => void
}

function ContactRow({ contact, onView, onEdit, onDelete }: ContactRowProps): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const registered = formatRegisteredDate(contact.registeredAt)
  const dial = countryDial(contact.phoneCountry)

  return (
    <li>
      <div className="group flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
        <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
          {contact.name.slice(0, 1).toUpperCase()}
        </div>

        <button type="button" onClick={onView} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium">
            {contact.country && (
              <span className="mr-1.5" title={contact.country}>
                {flagEmoji(contact.country)}
              </span>
            )}
            {contact.name}
          </p>
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
