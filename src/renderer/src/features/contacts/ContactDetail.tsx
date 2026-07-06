import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  Building2,
  Mail,
  Phone,
  Hash,
  CalendarClock,
  PhoneCall,
  ListChecks,
  ShieldAlert,
  Pencil
} from 'lucide-react'
import { flagEmoji, countryDial, countryName } from '@renderer/lib/countries'
import { formatDate, formatDuration } from '@renderer/features/calls/format'
import type { Call } from '@renderer/features/calls/types'
import type { Task } from '@renderer/features/tasks/types'
import type { Contact } from './types'

interface LinkedCall {
  call: Call
  tasks: Task[]
}

interface ContactDetailProps {
  contact: Contact
  onBack: () => void
  onEdit: () => void
}

/** The payoff view: everything linked to one person, chronologically — their
 *  calls, each with its summary, key objections (from coaching), and tasks. */
export function ContactDetail({ contact, onBack, onEdit }: ContactDetailProps): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [linked, setLinked] = useState<LinkedCall[]>([])

  useEffect(() => {
    let active = true
    // Reset for the newly-selected contact; state is only set again after the
    // await (and only while still mounted/current), matching the mount-time
    // data-fetch pattern used elsewhere (e.g. useTasks).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    void (async () => {
      const [summaries, tasks] = await Promise.all([
        window.api.calls.list(),
        window.api.tasks.list()
      ])
      const matches = summaries.filter((c) => c.contactId === contact.id)
      const calls = (await Promise.all(matches.map((c) => window.api.calls.get(c.id)))).filter(
        (c): c is Call => c !== null
      )
      calls.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      if (!active) return
      setLinked(calls.map((call) => ({ call, tasks: tasks.filter((t) => t.callId === call.id) })))
      setLoading(false)
    })()
    return () => {
      active = false
    }
  }, [contact.id])

  const registered = formatRegisteredDate(contact.registeredAt)
  const dial = countryDial(contact.phoneCountry)

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 text-sm text-muted transition hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Contacts
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
      </div>

      {/* Contact header */}
      <div className="mb-4 flex items-start gap-4 rounded-2xl border border-line-soft bg-surface p-6">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-accent-soft text-lg font-semibold text-accent">
          {contact.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {contact.country && (
              <span title={countryName(contact.country)}>{flagEmoji(contact.country)}</span>
            )}
            {contact.name}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
            {contact.company && (
              <span className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" /> {contact.company}
              </span>
            )}
            {contact.cid && (
              <span className="flex items-center gap-1.5">
                <Hash className="h-3.5 w-3.5" /> {contact.cid}
              </span>
            )}
            {contact.email && (
              <span className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" /> {contact.email}
              </span>
            )}
            {contact.phone && (
              <span className="flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5" /> {dial ? `${dial} ` : ''}
                {contact.phone}
              </span>
            )}
            {registered && (
              <span className="flex items-center gap-1.5">
                <CalendarClock className="h-3.5 w-3.5" /> Customer since {registered}
              </span>
            )}
          </div>
          {contact.notes && <p className="mt-3 text-sm text-muted">{contact.notes}</p>}
        </div>
      </div>

      {/* Call history */}
      <div className="flex-1 overflow-y-auto pb-2">
        <div className="mb-3 flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Call history</h3>
          {!loading && <span className="text-[11px] text-faint">{linked.length}</span>}
        </div>

        {loading ? (
          <div className="flex h-32 items-center justify-center text-sm text-faint">Loading…</div>
        ) : linked.length === 0 ? (
          <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
            No calls linked to {contact.name} yet. Open a saved call and link it here.
          </p>
        ) : (
          <ul className="space-y-3">
            {linked.map(({ call, tasks }) => (
              <LinkedCallCard key={call.id} call={call} tasks={tasks} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function formatRegisteredDate(value: string | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function LinkedCallCard({ call, tasks }: { call: Call; tasks: Task[] }): React.JSX.Element {
  const objection = call.coaching?.dimensions.find((d) => d.key === 'objection')

  return (
    <li className="rounded-xl border border-line-soft bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{call.title}</p>
        <div className="flex items-center gap-3 text-[11px] text-faint">
          <span>{formatDate(call.createdAt)}</span>
          <span>{formatDuration(call.durationMs)}</span>
        </div>
      </div>

      {call.summary ? (
        <p className="mt-2 text-[13px] text-muted">{call.summary.executive}</p>
      ) : (
        <p className="mt-2 text-[13px] text-faint">No AI summary generated for this call.</p>
      )}

      {objection?.comment && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-line-soft bg-canvas px-3 py-2.5">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Objections</p>
            <p className="mt-0.5 text-[13px] text-muted">{objection.comment}</p>
            {objection.evidence?.verified && (
              <p className="mt-1 text-[12px] italic text-faint">“{objection.evidence.quote}”</p>
            )}
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-line-soft bg-canvas px-3 py-2.5">
          <ListChecks className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
              Tasks ({tasks.length})
            </p>
            <ul className="mt-1 space-y-0.5">
              {tasks.map((t) => (
                <li key={t.id} className="truncate text-[13px] text-muted">
                  {t.status === 'done' ? '✓ ' : '• '}
                  {t.title}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </li>
  )
}
