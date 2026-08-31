import { useEffect, useMemo, useState } from 'react'
import {
  Building2,
  CalendarClock,
  PhoneCall,
  Pencil,
  GraduationCap,
  AlertTriangle,
  ListPlus,
  Sparkles
} from 'lucide-react'
import { openAssistantFor } from '@renderer/features/assistant/assistantNav'
import { ASSISTANT_SECTION_NAME } from '@renderer/features/assistant/config'
import { TONE_TEXT, overallTier } from '@renderer/features/coaching/meta'
import { Badge } from '@renderer/components/Badge'
import { Button } from '@renderer/components/Button'
import { BackButton } from '@renderer/components/BackButton'
import { StatCard } from '@renderer/components/StatCard'
import { useContactCallHistory } from '@renderer/features/contacts/useContactCallHistory'
import { CallHistoryList } from '@renderer/features/contacts/CallHistoryList'
import { formatRelative } from '@renderer/features/contacts/contactStats'
import type { Contact } from '@renderer/features/contacts/types'
import { recordRecentlyViewed } from '@renderer/lib/recentlyViewed'
import { formatValue, formatCloseDate } from './format'
import { isDealStale, createFollowUpTask } from './staleness'
import { RiskAssessmentCard } from './RiskAssessmentCard'
import { DealCallsSection } from './DealCallsSection'
import type { Deal, DealStage } from './types'

interface DealDetailProps {
  deal: Deal
  contact: Contact | undefined
  stage: DealStage | undefined
  staleFollowUpEnabled: boolean
  staleAfterDays: number
  onBack: () => void
  onEdit: () => void
  /** Called after the risk assessment runs, so the parent can refetch the deal. */
  onChanged: () => void
}

/** A deal's full context in one place: its own info plus the linked
 *  contact's entire call history (the same view Phase 1 built for a
 *  contact) — so there's no need to hop between screens for the story. */
export function DealDetail({
  deal,
  contact,
  stage,
  staleFollowUpEnabled,
  staleAfterDays,
  onBack,
  onEdit,
  onChanged
}: DealDetailProps): React.JSX.Element {
  const { loading, linked } = useContactCallHistory(deal.contactId)
  const [creatingTask, setCreatingTask] = useState(false)
  const [taskCreated, setTaskCreated] = useState(false)

  useEffect(() => {
    recordRecentlyViewed('deal', deal.id, deal.title)
  }, [deal.id, deal.title])

  const value = formatValue(deal.value)
  const closeDate = formatCloseDate(deal.expectedCloseDate)
  const stale =
    !loading &&
    isDealStale(
      stage,
      linked[0]?.call.createdAt,
      staleFollowUpEnabled,
      staleAfterDays,
      deal.createdAt
    )

  const handleCreateFollowUpTask = async (): Promise<void> => {
    setCreatingTask(true)
    try {
      await createFollowUpTask(deal, contact?.name)
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
        <BackButton onClick={onBack} label="Deals" />
        <div className="flex items-center gap-2">
          {/* M28 Part 4 — open the assistant scoped to this deal's client. */}
          <Button
            variant="secondary"
            size="sm"
            icon={Sparkles}
            onClick={() =>
              openAssistantFor({
                contactId: deal.contactId,
                contactName: contact?.name,
                company: contact?.company,
                dealId: deal.id,
                dealTitle: deal.title
              })
            }
          >
            Ask {ASSISTANT_SECTION_NAME}
          </Button>
          <Button variant="secondary" size="sm" icon={Pencil} onClick={onEdit}>
            Edit
          </Button>
        </div>
      </div>

      {/* Deal header */}
      <div className="mb-4 rounded-2xl border border-line-soft bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">{deal.title}</h2>
          {stage && (
            <Badge tone="neutral" className="shrink-0">
              {stage.label}
            </Badge>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted">
          <span className="flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5" /> {contact?.name ?? 'Unknown contact'}
            {contact?.company ? ` · ${contact.company}` : ''}
          </span>
          {value && <span className="font-medium tabular-nums text-ink">{value}</span>}
          {closeDate && (
            <span className="flex items-center gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" /> Closes {closeDate}
            </span>
          )}
        </div>
        {deal.notes && <p className="mt-3 text-sm whitespace-pre-line text-muted">{deal.notes}</p>}
      </div>

      {stale && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            <p className="text-[13px] text-ink">
              No calls with {contact?.name ?? 'this contact'} in over {staleAfterDays} days — this
              deal may need a follow-up.
            </p>
          </div>
          {taskCreated ? (
            <span className="shrink-0 text-[13px] font-medium text-positive">
              Task created — see Tasks.
            </span>
          ) : (
            <Button
              size="sm"
              icon={ListPlus}
              onClick={() => void handleCreateFollowUpTask()}
              disabled={creatingTask}
              className="shrink-0"
            >
              {creatingTask ? 'Creating…' : 'Create follow-up task'}
            </Button>
          )}
        </div>
      )}

      <div className="mb-4">
        <RiskAssessmentCard deal={deal} onAssessed={onChanged} />
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
            value={avgScore !== null ? `${avgScore} · ${overallTier(avgScore).label}` : '—'}
            tone={avgScore !== null ? TONE_TEXT[overallTier(avgScore).tone] : 'text-faint'}
          />
        </div>
      )}

      {/* M32 Stage 2 — THIS DEAL's calls, from `call.dealId`.
          What used to be here was the CONTACT's full history, which for a
          contact with two deals showed an identical list under both. It was
          not wrong about anything it claimed; it simply was not answering the
          question its heading asked. The contact's other calls are still
          right below, as candidates to link — which is what they are. */}
      <div className="flex-1 overflow-y-auto pb-2">
        <DealCallsSection
          dealId={deal.id}
          contactId={deal.contactId}
          contactName={contact?.name}
        />

        <div className="mt-6 border-t border-line-soft pt-5">
          <div className="mb-3 flex items-center gap-2">
            <PhoneCall className="h-4 w-4 text-faint" />
            <h3 className="text-sm font-semibold text-muted">
              Everything with {contact?.name ?? 'this contact'}
            </h3>
            {!loading && <span className="text-[11px] text-faint">{linked.length}</span>}
          </div>
          <CallHistoryList
            loading={loading}
            linked={linked}
            emptyMessage={`No calls linked to ${contact?.name ?? 'this contact'} yet. Open a saved call and link it there.`}
          />
        </div>
      </div>
    </div>
  )
}
