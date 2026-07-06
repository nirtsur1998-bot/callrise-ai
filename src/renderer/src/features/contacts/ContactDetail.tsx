import { useMemo } from 'react'
import {
  ArrowLeft,
  Building2,
  Mail,
  Phone,
  Hash,
  CalendarClock,
  PhoneCall,
  Pencil,
  GraduationCap
} from 'lucide-react'
import { flagEmoji, countryDial, countryName } from '@renderer/lib/countries'
import { TONE_TEXT, overallTier } from '@renderer/features/coaching/meta'
import { useContactCallHistory } from './useContactCallHistory'
import { CallHistoryList } from './CallHistoryList'
import { formatRelative } from './contactStats'
import type { Contact } from './types'

interface ContactDetailProps {
  contact: Contact
  onBack: () => void
  onEdit: () => void
}

/** The payoff view: everything linked to one person, chronologically — their
 *  calls, each with its summary, key objections (from coaching), and tasks. */
export function ContactDetail({ contact, onBack, onEdit }: ContactDetailProps): React.JSX.Element {
  const { loading, linked } = useContactCallHistory(contact.id)

  const registered = formatRegisteredDate(contact.registeredAt)
  const dial = countryDial(contact.phoneCountry)

  const avgScore = useMemo(() => {
    const scores = linked
      .map((l) => l.call.coaching?.overallScore)
      .filter((s): s is number => typeof s === 'number')
    if (!scores.length) return null
    return Math.round(scores.reduce((sum, s) => sum + s, 0) / scores.length)
  }, [linked])

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

      {/* Quick stats — the "so what" glance before diving into individual calls */}
      {!loading && linked.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-3">
          <StatCard icon={PhoneCall} label="Calls" value={String(linked.length)} tone="text-ink" />
          <StatCard
            icon={CalendarClock}
            label="Last contact"
            value={formatRelative(linked[0].call.createdAt)}
            tone="text-ink"
          />
          <StatCard
            icon={GraduationCap}
            label="Avg. coach score"
            value={avgScore !== null ? String(avgScore) : '—'}
            tone={avgScore !== null ? TONE_TEXT[overallTier(avgScore).tone] : 'text-faint'}
          />
        </div>
      )}

      {/* Call history */}
      <div className="flex-1 overflow-y-auto pb-2">
        <div className="mb-3 flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Call history</h3>
          {!loading && <span className="text-[11px] text-faint">{linked.length}</span>}
        </div>

        <CallHistoryList
          loading={loading}
          linked={linked}
          emptyMessage={`No calls linked to ${contact.name} yet. Open a saved call and link it here.`}
        />
      </div>
    </div>
  )
}

interface StatCardProps {
  icon: typeof PhoneCall
  label: string
  value: string
  tone: string
}

function StatCard({ icon: Icon, label, value, tone }: StatCardProps): React.JSX.Element {
  return (
    <div className="rounded-xl border border-line-soft bg-surface px-4 py-3">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
        <Icon className="h-3 w-3" /> {label}
      </p>
      <p className={`mt-1 text-lg font-semibold ${tone}`}>{value}</p>
    </div>
  )
}

function formatRegisteredDate(value: string | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
