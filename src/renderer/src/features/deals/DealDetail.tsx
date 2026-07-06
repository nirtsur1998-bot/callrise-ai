import { useMemo } from 'react'
import { ArrowLeft, Building2, CalendarClock, PhoneCall, Pencil, GraduationCap } from 'lucide-react'
import { TONE_TEXT, overallTier } from '@renderer/features/coaching/meta'
import { useContactCallHistory } from '@renderer/features/contacts/useContactCallHistory'
import { CallHistoryList } from '@renderer/features/contacts/CallHistoryList'
import { formatRelative } from '@renderer/features/contacts/contactStats'
import type { Contact } from '@renderer/features/contacts/types'
import { formatValue, formatCloseDate } from './format'
import type { Deal, DealStage } from './types'

interface DealDetailProps {
  deal: Deal
  contact: Contact | undefined
  stage: DealStage | undefined
  onBack: () => void
  onEdit: () => void
}

/** A deal's full context in one place: its own info plus the linked
 *  contact's entire call history (the same view Phase 1 built for a
 *  contact) — so there's no need to hop between screens for the story. */
export function DealDetail({
  deal,
  contact,
  stage,
  onBack,
  onEdit
}: DealDetailProps): React.JSX.Element {
  const { loading, linked } = useContactCallHistory(deal.contactId)

  const value = formatValue(deal.value)
  const closeDate = formatCloseDate(deal.expectedCloseDate)

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
          <ArrowLeft className="h-4 w-4" /> Deals
        </button>
        <button
          type="button"
          onClick={onEdit}
          className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
      </div>

      {/* Deal header */}
      <div className="mb-4 rounded-2xl border border-line-soft bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">{deal.title}</h2>
          {stage && (
            <span className="shrink-0 rounded-full border border-line-soft bg-canvas px-2.5 py-1 text-[12px] font-medium text-muted">
              {stage.label}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
          <span className="flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5" /> {contact?.name ?? 'Unknown contact'}
            {contact?.company ? ` · ${contact.company}` : ''}
          </span>
          {value && <span className="font-medium text-ink">{value}</span>}
          {closeDate && (
            <span className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" /> Closes {closeDate}
            </span>
          )}
        </div>
        {deal.notes && <p className="mt-3 text-sm text-muted">{deal.notes}</p>}
      </div>

      {/* Quick stats — the same "so what" glance the Contact detail view shows */}
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

      {/* Call history — the linked contact's full history, same as Phase 1 */}
      <div className="flex-1 overflow-y-auto pb-2">
        <div className="mb-3 flex items-center gap-2">
          <PhoneCall className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-semibold">Call history</h3>
          {!loading && <span className="text-[11px] text-faint">{linked.length}</span>}
        </div>

        <CallHistoryList
          loading={loading}
          linked={linked}
          emptyMessage={`No calls linked to ${contact?.name ?? 'this contact'} yet. Open a saved call and link it there.`}
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
