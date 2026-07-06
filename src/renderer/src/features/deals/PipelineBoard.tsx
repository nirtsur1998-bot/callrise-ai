import { ChevronLeft, ChevronRight, PhoneCall, Building2 } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { Contact } from '@renderer/features/contacts/types'
import {
  recencyTone,
  formatRelative,
  type ContactStats
} from '@renderer/features/contacts/contactStats'
import { TONE_TEXT } from '@renderer/features/coaching/meta'
import { formatValue } from './format'
import type { Deal, DealStage } from './types'

interface PipelineBoardProps {
  deals: Deal[]
  stages: DealStage[]
  contactById: Map<string, Contact>
  contactStats: Map<string, ContactStats>
  onMoveStage: (dealId: string, stageId: string) => void
  onOpen: (deal: Deal) => void
}

const KIND_HEADER_TEXT: Record<DealStage['kind'], string> = {
  open: 'text-ink',
  won: 'text-emerald-300',
  lost: 'text-rose-300'
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
  onMoveStage,
  onOpen
}: PipelineBoardProps): React.JSX.Element {
  const dealsByStage = new Map<string, Deal[]>()
  for (const deal of deals) {
    const list = dealsByStage.get(deal.stageId)
    if (list) list.push(deal)
    else dealsByStage.set(deal.stageId, [deal])
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {stages.map((stage, stageIndex) => {
        const stageDeals = dealsByStage.get(stage.id) ?? []
        const total = stageDeals.reduce((sum, d) => sum + (d.value ?? 0), 0)
        return (
          <div key={stage.id} className="w-64 shrink-0">
            <div className="mb-2.5 flex items-baseline justify-between px-1">
              <h3 className={cn('text-sm font-semibold', KIND_HEADER_TEXT[stage.kind])}>
                {stage.label}
              </h3>
              <span className="text-[11px] text-faint">
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
                    canMovePrev={stageIndex > 0}
                    canMoveNext={stageIndex < stages.length - 1}
                    onMovePrev={() => onMoveStage(deal.id, stages[stageIndex - 1].id)}
                    onMoveNext={() => onMoveStage(deal.id, stages[stageIndex + 1].id)}
                    onEdit={() => onOpen(deal)}
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
  canMovePrev: boolean
  canMoveNext: boolean
  onMovePrev: () => void
  onMoveNext: () => void
  onEdit: () => void
}

function DealCard({
  deal,
  contact,
  stats,
  canMovePrev,
  canMoveNext,
  onMovePrev,
  onMoveNext,
  onEdit
}: DealCardProps): React.JSX.Element {
  const value = formatValue(deal.value)
  const tone = recencyTone(stats?.lastCallAt)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onEdit()
      }}
      className="cursor-pointer rounded-xl border border-line-soft bg-surface p-3.5 transition hover:border-line hover:bg-elevated"
    >
      <p className="truncate text-sm font-medium">{deal.title}</p>
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
        className="mt-2.5 flex items-center justify-between border-t border-line-soft pt-2"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onMovePrev}
          disabled={!canMovePrev}
          title="Move to previous stage"
          className="grid h-7 w-7 place-items-center rounded-lg text-faint transition hover:bg-canvas hover:text-ink disabled:opacity-20"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="text-[10px] uppercase tracking-wide text-faint">Move</span>
        <button
          type="button"
          onClick={onMoveNext}
          disabled={!canMoveNext}
          title="Move to next stage"
          className="grid h-7 w-7 place-items-center rounded-lg text-faint transition hover:bg-canvas hover:text-ink disabled:opacity-20"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
