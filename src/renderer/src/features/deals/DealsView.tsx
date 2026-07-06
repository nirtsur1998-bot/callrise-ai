import { useEffect, useMemo, useState } from 'react'
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
import { useContacts } from '@renderer/features/contacts/useContacts'
import {
  buildContactStats,
  recencyTone,
  formatRelative
} from '@renderer/features/contacts/contactStats'
import { TONE_TEXT } from '@renderer/features/coaching/meta'
import type { CallSummary } from '@renderer/features/calls/types'
import { useDeals } from './useDeals'
import { useDealStages } from './useDealStages'
import { DealFormDialog, type DealFormValues } from './DealFormDialog'
import { StageEditorDialog } from './StageEditorDialog'
import { PipelineBoard } from './PipelineBoard'
import { formatValue, formatCloseDate } from './format'
import type { Deal } from './types'

const ALL_STAGES = 'all'
type ViewMode = 'board' | 'list'

export function DealsView(): React.JSX.Element {
  const { deals, loading, create, update, remove } = useDeals()
  const { stages, loading: stagesLoading, save: saveStages } = useDealStages()
  const { contacts } = useContacts()
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [stageFilter, setStageFilter] = useState(ALL_STAGES)
  const [view, setView] = useState<ViewMode>('board')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Deal | null>(null)
  const [managingStages, setManagingStages] = useState(false)

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

  const visible = useMemo(() => {
    const filtered =
      stageFilter === ALL_STAGES ? deals : deals.filter((d) => d.stageId === stageFilter)
    return [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }, [deals, stageFilter])

  const busy = loading || stagesLoading

  const moveStage = (dealId: string, stageId: string): void => {
    void update(dealId, { stageId })
  }

  return (
    <div className={view === 'board' ? '' : 'mx-auto max-w-3xl'}>
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight">Deals</h2>
          <span className="text-[13px] text-faint">{deals.length} total</span>
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
          <button
            type="button"
            onClick={() => setManagingStages(true)}
            title="Manage stages"
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-ink"
          >
            <Settings2 className="h-4 w-4" /> Stages
          </button>
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={contacts.length === 0}
            title={contacts.length === 0 ? 'Add a contact first' : undefined}
            className="flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Add deal
          </button>
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
        <div className="flex h-40 items-center justify-center text-sm text-faint">Loading…</div>
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
          onMoveStage={moveStage}
          onEdit={setEditing}
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
            return (
              <DealRow
                key={deal.id}
                deal={deal}
                contactName={contact?.name ?? 'Unknown contact'}
                contactCompany={contact?.company}
                stageLabel={stageLabel.get(deal.stageId)?.label ?? '—'}
                lastCallAt={stats?.lastCallAt}
                onEdit={() => setEditing(deal)}
                onDelete={() => void remove(deal.id)}
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
  onEdit: () => void
  onDelete: () => void
}

function DealRow({
  deal,
  contactName,
  contactCompany,
  stageLabel,
  lastCallAt,
  onEdit,
  onDelete
}: DealRowProps): React.JSX.Element {
  const [confirm, setConfirm] = useState(false)
  const value = formatValue(deal.value)
  const closeDate = formatCloseDate(deal.expectedCloseDate)
  const tone = recencyTone(lastCallAt)

  return (
    <li>
      <div className="group flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5 transition hover:border-line hover:bg-elevated">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate text-sm font-medium">{deal.title}</p>
            <span className="shrink-0 rounded-full border border-line-soft bg-canvas px-2 py-0.5 text-[11px] font-medium text-muted">
              {stageLabel}
            </span>
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
          {deal.notes && <p className="mt-1.5 text-[12px] text-muted">{deal.notes}</p>}
        </div>

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
                title="Edit deal"
                className="grid h-8 w-8 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-canvas hover:text-ink group-hover:opacity-100"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setConfirm(true)}
                title="Delete deal"
                className="grid h-8 w-8 place-items-center rounded-lg text-faint opacity-0 transition hover:bg-canvas hover:text-rose-300 group-hover:opacity-100"
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
        <Handshake className="h-6 w-6 text-faint" strokeWidth={1.75} />
      </div>
      <h3 className="text-lg font-semibold">No deals yet</h3>
      <p className="mt-1.5 max-w-xs text-sm text-muted">
        Track an opportunity through your pipeline, linked to the contact it&apos;s with.
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-4 flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition hover:brightness-110"
      >
        <Plus className="h-4 w-4" /> Add deal
      </button>
    </div>
  )
}
