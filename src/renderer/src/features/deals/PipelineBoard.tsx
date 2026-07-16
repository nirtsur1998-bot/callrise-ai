import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, PhoneCall, Building2 } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Badge } from '@renderer/components/Badge'
import type { Contact } from '@renderer/features/contacts/types'
import {
  recencyTone,
  formatRelative,
  type ContactStats
} from '@renderer/features/contacts/contactStats'
import { TONE_TEXT } from '@renderer/features/coaching/meta'
import { formatValue } from './format'
import { isDealStale } from './staleness'
import { StaleBadge } from './StaleBadge'
import { RISK_TIER_TONE } from './risk'
import type { Deal, DealStage } from './types'

interface PipelineBoardProps {
  deals: Deal[]
  stages: DealStage[]
  contactById: Map<string, Contact>
  contactStats: Map<string, ContactStats>
  staleFollowUpEnabled: boolean
  staleAfterDays: number
  onMoveStage: (dealId: string, stageId: string) => void
  onOpen: (deal: Deal) => void
}

const KIND_HEADER_TEXT: Record<DealStage['kind'], string> = {
  open: 'text-ink',
  won: 'text-positive',
  lost: 'text-danger'
}

const KIND_RULE: Record<DealStage['kind'], string> = {
  open: 'border-t-line',
  won: 'border-t-positive',
  lost: 'border-t-danger'
}

const KIND_COUNT_PILL: Record<DealStage['kind'], string> = {
  open: 'text-faint',
  won: 'rounded-full bg-positive-soft px-1.5 py-0.5 text-positive',
  lost: 'rounded-full bg-danger-soft px-1.5 py-0.5 text-danger'
}

/** A simple kanban: columns = stages (in configured order), cards = deals.
 *  Moving a deal uses prev/next chevrons rather than drag-and-drop — see the
 *  Step 1 tradeoff note: keyboard-accessible, no new dependency, and just as
 *  fast for the common "move it one stage over" case. Click a card to open
 *  its detail view (full edit — including jumping to any stage — lives there). */
export function PipelineBoard({
  deals,
  stages,
  contactById,
  contactStats,
  staleFollowUpEnabled,
  staleAfterDays,
  onMoveStage,
  onOpen
}: PipelineBoardProps): React.JSX.Element {
  const [recentlyMovedId, setRecentlyMovedId] = useState<string | null>(null)
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (flashTimeout.current) clearTimeout(flashTimeout.current)
    }
  }, [])

  const handleMove = (dealId: string, stageId: string): void => {
    onMoveStage(dealId, stageId)
    setRecentlyMovedId(dealId)
    if (flashTimeout.current) clearTimeout(flashTimeout.current)
    flashTimeout.current = setTimeout(() => setRecentlyMovedId(null), 700)
  }

  const dealsByStage = new Map<string, Deal[]>()
  for (const deal of deals) {
    const list = dealsByStage.get(deal.stageId)
    if (list) list.push(deal)
    else dealsByStage.set(deal.stageId, [deal])
  }

  // Deals whose stageId matches no configured stage (a reset/hand-edited
  // stage list). Without an extra column they'd simply VANISH from the board
  // — the header would say "N total" while the cards were nowhere.
  const knownStageIds = new Set(stages.map((s) => s.id))
  const orphaned = deals.filter((d) => !knownStageIds.has(d.stageId))

  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {orphaned.length > 0 && (
        <div className="w-64 shrink-0">
          <div className="mb-2.5 flex items-baseline justify-between px-1">
            <h3 className="text-sm font-semibold text-warning">No stage</h3>
            <span className="text-[11px] text-faint">{orphaned.length}</span>
          </div>
          <p className="mb-2.5 px-1 text-[11px] text-faint">
            These deals point at a stage that no longer exists — use the arrow to move each into a
            real stage.
          </p>
          <div className="space-y-2.5">
            {orphaned.map((deal) => (
              <DealCard
                key={deal.id}
                deal={deal}
                contact={contactById.get(deal.contactId)}
                stats={contactStats.get(deal.contactId)}
                stale={false}
                canMovePrev={false}
                canMoveNext={stages.length > 0}
                onMovePrev={() => {}}
                onMoveNext={() => handleMove(deal.id, stages[0].id)}
                onEdit={() => onOpen(deal)}
                flash={deal.id === recentlyMovedId}
              />
            ))}
          </div>
        </div>
      )}
      {stages.map((stage, stageIndex) => {
        const stageDeals = dealsByStage.get(stage.id) ?? []
        const total = stageDeals.reduce((sum, d) => sum + (d.value ?? 0), 0)
        return (
          <div key={stage.id} className="w-64 shrink-0">
            <div
              className={cn(
                'mb-2.5 flex items-baseline justify-between border-t-2 px-1 pt-2',
                KIND_RULE[stage.kind]
              )}
            >
              <h3 className={cn('text-sm font-semibold', KIND_HEADER_TEXT[stage.kind])}>
                {stage.label}
              </h3>
              <span className={cn('text-[11px] font-medium', KIND_COUNT_PILL[stage.kind])}>
                {stageDeals.length}
                {total > 0 ? ` · ${formatValue(total)}` : ''}
              </span>
            </div>
            <div className="space-y-2.5">
              {stageDeals.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line-soft px-3 py-6 text-center text-[12px] text-faint">
                  No deals here
                </div>
              ) : (
                stageDeals.map((deal) => (
                  <DealCard
                    key={deal.id}
                    deal={deal}
                    contact={contactById.get(deal.contactId)}
                    stats={contactStats.get(deal.contactId)}
                    stale={isDealStale(
                      stage,
                      contactStats.get(deal.contactId)?.lastCallAt,
                      staleFollowUpEnabled,
                      staleAfterDays,
                      deal.createdAt
                    )}
                    canMovePrev={stageIndex > 0}
                    canMoveNext={stageIndex < stages.length - 1}
                    onMovePrev={() => handleMove(deal.id, stages[stageIndex - 1].id)}
                    onMoveNext={() => handleMove(deal.id, stages[stageIndex + 1].id)}
                    onEdit={() => onOpen(deal)}
                    flash={deal.id === recentlyMovedId}
                  />
                ))
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

interface DealCardProps {
  deal: Deal
  contact: Contact | undefined
  stats: ContactStats | undefined
  stale: boolean
  canMovePrev: boolean
  canMoveNext: boolean
  onMovePrev: () => void
  onMoveNext: () => void
  onEdit: () => void
  flash?: boolean
}

function DealCard({
  deal,
  contact,
  stats,
  stale,
  canMovePrev,
  canMoveNext,
  onMovePrev,
  onMoveNext,
  onEdit,
  flash
}: DealCardProps): React.JSX.Element {
  const value = formatValue(deal.value)
  const tone = recencyTone(stats?.lastCallAt)
  const risk = deal.riskAssessment?.level

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEdit()
        if (e.key === ' ') {
          e.preventDefault()
          onEdit()
        }
      }}
      className={cn(
        'press group cursor-pointer rounded-xl border border-line-soft bg-surface p-3.5 transition hover:border-line hover:bg-elevated',
        flash && 'flash'
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium">{deal.title}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          {stale && <StaleBadge />}
          {(risk === 'high' || risk === 'medium') && (
            <Badge tone={RISK_TIER_TONE[risk === 'high' ? 'risk-high' : 'risk-medium']}>
              {risk === 'high' ? 'High risk' : 'Medium risk'}
            </Badge>
          )}
        </div>
      </div>
      <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-faint">
        <Building2 className="h-3 w-3 shrink-0" />
        {contact?.name ?? 'Unknown contact'}
        {contact?.company ? ` · ${contact.company}` : ''}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2">
        {value ? (
          <span className="text-[13px] font-semibold text-ink">{value}</span>
        ) : (
          <span className="text-[11px] text-faint">No value set</span>
        )}
        <span className={cn('flex items-center gap-1 text-[11px]', TONE_TEXT[tone])}>
          <PhoneCall className="h-3 w-3" />
          {stats?.lastCallAt ? formatRelative(stats.lastCallAt) : 'no calls'}
        </span>
      </div>

      <div
        className="mt-2.5 flex items-center justify-between border-t border-line-soft pt-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onMovePrev}
          disabled={!canMovePrev}
          title="Move to previous stage"
          aria-label="Move to previous stage"
          className="press grid h-7 w-7 place-items-center rounded-lg text-faint transition hover:bg-canvas hover:text-ink disabled:opacity-20"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-[10px] uppercase tracking-wide text-faint">Move</span>
        <button
          type="button"
          onClick={onMoveNext}
          disabled={!canMoveNext}
          title="Move to next stage"
          aria-label="Move to next stage"
          className="press grid h-7 w-7 place-items-center rounded-lg text-faint transition hover:bg-canvas hover:text-ink disabled:opacity-20"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
