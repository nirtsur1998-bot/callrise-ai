import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  Building2,
  Mail,
  Phone,
  Hash,
  CalendarClock,
  PhoneCall,
  Pencil,
  GraduationCap,
  AlertTriangle,
  ListPlus,
  CheckCircle2
} from 'lucide-react'
import { flagEmoji, countryDial, countryName } from '@renderer/lib/countries'
import { TONE_TEXT, overallTier } from '@renderer/features/coaching/meta'
import { isContactStale, createContactFollowUpTask } from '@renderer/features/deals/staleness'
import { useContactCallHistory } from './useContactCallHistory'
import { CallHistoryList } from './CallHistoryList'
import { formatRelative } from './contactStats'
import type { Contact } from './types'
import { formatDateOnly } from '@renderer/lib/dateOnly'

interface ContactDetailProps {
  contact: Contact
  hasOpenDeal: boolean
  staleFollowUpEnabled: boolean
  staleAfterDays: number
  onBack: () => void
  onEdit: () => void
}

/** The payoff view: everything linked to one person, chronologically — their
 *  calls, each with its summary, key objections (from coaching), and tasks. */
export function ContactDetail({
  contact,
  hasOpenDeal,
  staleFollowUpEnabled,
  staleAfterDays,
  onBack,
  onEdit
}: ContactDetailProps): React.JSX.Element {
  const { loading, linked } = useContactCallHistory(contact.id)
  const [creatingTask, setCreatingTask] = useState(false)
  const [taskCreated, setTaskCreated] = useState(false)

  const registered = formatRegisteredDate(contact.registeredAt)
  const dial = countryDial(contact.phoneCountry)
  const stale =
    !loading &&
    isContactStale(
      hasOpenDeal,
      linked[0]?.call.createdAt,
      staleFollowUpEnabled,
      staleAfterDays,
      contact.createdAt
    )

  const handleCreateFollowUpTask = async (): Promise<void> => {
    setCreatingTask(true)
    try {
      await createContactFollowUpTask(contact.id, contact.name)
      setTaskCreated(true)
    } catch {
      /* button stays visible for a retry */
    } finally {
      setCreatingTask(false)
    }
  }

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
          {contact.notes && (
            <p className="mt-3 text-sm whitespace-pre-line text-muted">{contact.notes}</p>
          )}
        </div>
      </div>

      {stale && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-300" />
            <p className="text-[13px] text-ink">
              No calls with {contact.name} in over {staleAfterDays} days — may need a follow-up.
            </p>
          </div>
          {taskCreated ? (
            <span className="shrink-0 flex items-center gap-1 text-[13px] font-medium text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" /> Task created — see Tasks.
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void handleCreateFollowUpTask()}
              disabled={creatingTask}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:brightness-110 disabled:opacity-50"
            >
              <ListPlus className="h-3.5 w-3.5" />
              {creatingTask ? 'Creating…' : 'Create follow-up task'}
            </button>
          )}
        </div>
      )}

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

// registeredAt is DATE-ONLY — formatDateOnly avoids the UTC-midnight parse
// that displayed the previous day for users west of UTC.
const formatRegisteredDate = formatDateOnly
