import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus,
  Handshake,
  Building2,
  CalendarClock,
  Pencil,
  Trash2,
  Settings2,
  PhoneCall,
  LayoutGrid,
  List
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Badge } from '@renderer/components/Badge'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'
import { SkeletonRows } from '@renderer/components/Skeleton'
import { useContacts } from '@renderer/features/contacts/useContacts'
import {
  buildContactStats,
  recencyTone,
  formatRelative
} from '@renderer/features/contacts/contactStats'
import { TONE_TEXT } from '@renderer/features/coaching/meta'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import { useToast } from '@renderer/features/notifications/useToast'
import type { CallSummary } from '@renderer/features/calls/types'
import { useDeals } from './useDeals'
import { useDealStages } from './useDealStages'
import { DealFormDialog, type DealFormValues } from './DealFormDialog'
import { StageEditorDialog } from './StageEditorDialog'
import { PipelineBoard } from './PipelineBoard'
import { DealDetail } from './DealDetail'
import { isDealStale } from './staleness'
import { StaleBadge } from './StaleBadge'
import { RISK_TIER_TONE } from './risk'
import { formatValue, formatCloseDate } from './format'
import type { Deal } from './types'

const ALL_STAGES = 'all'
type ViewMode = 'board' | 'list'

interface DealsViewProps {
  /** Deep-link from the follow-up digest (or elsewhere): open this deal on mount. */
  initialViewDealId?: string | null
  /** Called once the initial selection above has been applied, so the parent
   *  can clear it (otherwise a later plain visit would reopen the same deal). */
  onInitialViewConsumed?: () => void
}

export function DealsView({
  initialViewDealId = null,
  onInitialViewConsumed
}: DealsViewProps = {}): React.JSX.Element {
  const { deals, loading, create, update, remove, undoDelete, refresh } = useDeals()
  const { stages, loading: stagesLoading, save: saveStages } = useDealStages()
  const { contacts } = useContacts()
  const { settings } = useAppSettings()
  const toast = useToast()
  const { staleFollowUpEnabled, staleAfterDays } = settings.crm
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [stageFilter, setStageFilter] = useState(ALL_STAGES)
  const [view, setView] = useState<ViewMode>('board')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Deal | null>(null)
  const [managingStages, setManagingStages] = useState(false)
  const [viewingId, setViewingId] = useState<string | null>(initialViewDealId)

  const consumedRef = useRef(false)
  useEffect(() => {
    if (initialViewDealId && !consumedRef.current) {
      consumedRef.current = true
      onInitialViewConsumed?.()
    }
  }, [initialViewDealId, onInitialViewConsumed])

  useEffect(() => {
    let active = true
    void window.api.calls.list().then((list) => {
      if (active) setCalls(list)
    })
    return () => {
      active = false
    }
  }, [])

  const contactStats = useMemo(() => buildContactStats(calls), [calls])
  const stageLabel = useMemo(() => new Map(stages.map((s) => [s.id, s])), [stages])
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])

  const { openCount, openTotal } = useMemo(() => {
    let count = 0
    let total = 0
    for (const deal of deals) {
      if (stageLabel.get(deal.stageId)?.kind === 'open') {
        count += 1
        total += deal.value ?? 0
      }
    }
    return { openCount: count, openTotal: total }
  }, [deals, stageLabel])

  const visible = useMemo(() => {
    const filtered =
      stageFilter === ALL_STAGES ? deals : deals.filter((d) => d.stageId === stageFilter)
    return [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [deals, stageFilter])

  const busy = loading || stagesLoading

  const moveStage = (dealId: string, stageId: string): void => {
    void update(dealId, { stageId })
  }

  const viewing = viewingId ? deals.find((d) => d.id === viewingId) : undefined

  if (viewing) {
    return (
      <>
        <DealDetail
          deal={viewing}
          contact={contactById.get(viewing.contactId)}
          stage={stageLabel.get(viewing.stageId)}
          staleFollowUpEnabled={staleFollowUpEnabled}
          staleAfterDays={staleAfterDays}
          onBack={() => setViewingId(null)}
          onEdit={() => setEditing(viewing)}
          onChanged={() => void refresh()}
        />
        {editing && (
          <DealFormDialog
            deal={editing}
            stages={stages}
            onClose={() => setEditing(null)}
            onSubmit={async (values: DealFormValues) => {
              await update(editing.id, values)
              setEditing(null)
            }}
          />
        )}
      </>
    )
  }

  return (
    <div className={view === 'board' ? '' : 'mx-auto max-w-3xl'}>
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">Deals</h2>
          <span className="text-[13px] text-faint">
            {deals.length} total
            {openCount > 0 && ` · ${openCount} open · ${formatValue(openTotal)} in the pipeline`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-lg border border-line p-0.5">
            <button
              type="button"
              onClick={() => setView('board')}
              title="Board view"
              className={cn(
                'grid h-8 w-8 place-items-center rounded-md transition',
                view === 'board' ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink'
              )}
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setView('list')}
              title="List view"
              className={cn(
                'grid h-8 w-8 place-items-center rounded-md transition',
                view === 'list' ? 'bg-accent-soft text-ink' : 'text-muted hover:text-ink'
              )}
            >
              <List className="h-4 w-4" />
            </button>
          </div>
          <Button
            variant="secondary"
            icon={Settings2}
            onClick={() => setManagingStages(true)}
            title="Manage stages"
          >
            Stages
          </Button>
          <Button
            icon={Plus}
            onClick={() => setAdding(true)}
            disabled={contacts.length === 0}
            title={contacts.length === 0 ? 'Add a contact first' : undefined}
          >
            Add deal
          </Button>
        </div>
      </div>
      <p className="mb-5 text-[13px] text-faint">
        Opportunities you&apos;re tracking through the pipeline, one per contact.
      </p>

      {view === 'list' && deals.length > 0 && stages.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <FilterChip
            active={stageFilter === ALL_STAGES}
            onClick={() => setStageFilter(ALL_STAGES)}
            label="All"
          />
          {stages.map((s) => (
            <FilterChip
              key={s.id}
              active={stageFilter === s.id}
              onClick={() => setStageFilter(s.id)}
              label={s.label}
            />
          ))}
        </div>
      )}

      {busy ? (
        <SkeletonRows rows={4} />
      ) : contacts.length === 0 ? (
        <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
          Add a contact first — every deal belongs to someone.
        </p>
      ) : deals.length === 0 ? (
        <EmptyAll onAdd={() => setAdding(true)} />
      ) : view === 'board' ? (
        <PipelineBoard
          deals={deals}
          stages={stages}
          contactById={contactById}
          contactStats={contactStats}
          staleFollowUpEnabled={staleFollowUpEnabled}
          staleAfterDays={staleAfterDays}
          onMoveStage={moveStage}
          onOpen={(deal) => setViewingId(deal.id)}
        />
      ) : visible.length === 0 ? (
        <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
          No deals in this stage.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {visible.map((deal) => {
            const contact = contactById.get(deal.contactId)
            const stats = contactStats.get(deal.contactId)
            const stale = isDealStale(
              stageLabel.get(deal.stageId),
              stats?.lastCallAt,
              staleFollowUpEnabled,
              staleAfterDays,
              deal.createdAt
            )
            return (
              <DealRow
                key={deal.id}
                deal={deal}
                contactName={contact?.name ?? 'Unknown contact'}
                contactCompany={contact?.company}
                stageLabel={stageLabel.get(deal.stageId)?.label ?? '—'}
                lastCallAt={stats?.lastCallAt}
                stale={stale}
                onView={() => setViewingId(deal.id)}
                onEdit={() => setEditing(deal)}
                onDelete={() => {
                  remove(deal.id)
                  toast.error('Deal deleted', {
                    label: 'Undo',
                    onClick: () => undoDelete(deal.id)
                  })
                }}
              />
            )
          })}
        </ul>
      )}

      {adding && (
        <DealFormDialog
          stages={stages}
          onClose={() => setAdding(false)}
          onSubmit={async (values: DealFormValues) => {
            await create(values)
            setAdding(false)
          }}
        />
      )}
      {editing && (
        <DealFormDialog
          deal={editing}
          stages={stages}
          onClose={() => setEditing(null)}
          onSubmit={async (values: DealFormValues) => {
            await update(editing.id, values)
            setEditing(null)
          }}
        />
      )}
      {managingStages && (
        <StageEditorDialog
          stages={stages}
          onClose={() => setManagingStages(false)}
          onSave={async (next) => {
            const result = await saveStages(next)
            if (result.ok) setManagingStages(false)
            return result
          }}
        />
      )}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  label
}: {
  active: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg px-3 py-1.5 text-[13px] font-medium transition',
        active ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-elevated hover:text-ink'
      )}
    >
      {label}
    </button>
  )
}

interface DealRowProps {
  deal: Deal
  contactName: string
  contactCompany: string | undefined
  stageLabel: string
  lastCallAt: string | undefined
  stale: boolean
  onView: () => void
  onEdit: () => void
  onDelete: () => void
}

function DealRow({
  deal,
  contactName,
  contactCompany,
  stageLabel,
  lastCallAt,
  stale,
  onView,
  onEdit,
  onDelete
}: DealRowProps): React.JSX.Element {
  const value = formatValue(deal.value)
  const closeDate = formatCloseDate(deal.expectedCloseDate)
  const tone = recencyTone(lastCallAt)

  return (
    <li>
      <div className="group flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
        <button type="button" onClick={onView} className="min-w-0 flex-1 text-left">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-sm font-medium">{deal.title}</p>
            <div className="flex shrink-0 items-center gap-1.5">
              {stale && <StaleBadge />}
              {(deal.riskAssessment?.level === 'high' ||
                deal.riskAssessment?.level === 'medium') && (
                <Badge
                  tone={
                    RISK_TIER_TONE[
                      deal.riskAssessment.level === 'high' ? 'risk-high' : 'risk-medium'
                    ]
                  }
                >
                  {deal.riskAssessment.level === 'high' ? 'High risk' : 'Medium risk'}
                </Badge>
              )}
              <Badge tone="neutral">{stageLabel}</Badge>
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
            <span className="flex items-center gap-1">
              <Building2 className="h-3 w-3" /> {contactName}
              {contactCompany ? ` · ${contactCompany}` : ''}
            </span>
            {value && <span className="font-medium text-ink">{value}</span>}
            {closeDate && (
              <span className="flex items-center gap-1">
                <CalendarClock className="h-3 w-3" /> Closes {closeDate}
              </span>
            )}
            <span className={cn('flex items-center gap-1', TONE_TEXT[tone])}>
              <PhoneCall className="h-3 w-3" />
              {lastCallAt ? `Last call ${formatRelative(lastCallAt)}` : 'No calls yet'}
            </span>
          </div>
          {deal.notes && <p className="mt-1.5 line-clamp-2 text-[12px] text-muted">{deal.notes}</p>}
        </button>

        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            icon={Pencil}
            label="Edit deal"
            onClick={onEdit}
            className="opacity-0 group-hover:opacity-100"
          />
          <IconButton
            icon={Trash2}
            label="Delete deal"
            variant="danger"
            onClick={onDelete}
            className="opacity-0 group-hover:opacity-100"
          />
        </div>
      </div>
    </li>
  )
}

function EmptyAll({ onAdd }: { onAdd: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
        <Handshake className="h-6 w-6 text-faint" strokeWidth={1.75} />
      </div>
      <h3 className="text-lg font-semibold">No deals yet</h3>
      <p className="mt-1.5 max-w-xs text-sm text-muted">
        Track an opportunity through your pipeline, linked to the contact it&apos;s with.
      </p>
      <Button icon={Plus} onClick={onAdd} className="mt-4">
        Add deal
      </Button>
    </div>
  )
}
