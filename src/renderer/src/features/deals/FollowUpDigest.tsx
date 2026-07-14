import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircle2,
  Circle,
  Building2,
  PhoneCall,
  ListPlus,
  AlertTriangle,
  ShieldAlert,
  CalendarClock
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { useContacts } from '@renderer/features/contacts/useContacts'
import { buildContactStats, daysSinceLastCall } from '@renderer/features/contacts/contactStats'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import { useTasks } from '@renderer/features/tasks/useTasks'
import { TASK_TYPE_META, PRIORITY_META, DUE_TONE_CLASS } from '@renderer/features/tasks/meta'
import { formatDueLabel } from '@renderer/features/tasks/format'
import type { Task } from '@renderer/features/tasks/types'
import type { CallSummary } from '@renderer/features/calls/types'
import type { CalendarEvent } from '@renderer/features/calendar/types'
import type { Contact } from '@renderer/features/contacts/types'
import { useDeals } from './useDeals'
import { useDealStages } from './useDealStages'
import {
  dealAttentionTier,
  ATTENTION_TIER_RANK,
  isContactStale,
  contactsWithOpenDeals,
  createFollowUpTask,
  createContactFollowUpTask,
  type AttentionTier
} from './staleness'
import { formatValue } from './format'
import type { Deal } from './types'

interface FollowUpDigestProps {
  onOpenDeal: (dealId: string) => void
  onOpenContact: (contactId: string) => void
}

const RISK_TIER_LABEL: Record<'risk-high' | 'risk-medium', string> = {
  'risk-high': 'High risk',
  'risk-medium': 'Medium risk'
}
const RISK_TIER_CLASS: Record<'risk-high' | 'risk-medium', string> = {
  'risk-high': 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  'risk-medium': 'border-amber-500/30 bg-amber-500/10 text-amber-300'
}

/** One flagged item — a deal (risk-flagged or gone quiet), or a deal-less
 *  contact who's gone quiet. `reason` is the plain-language "why", shown up
 *  front: the AI risk summary for risk-tiered deals, or a recency line for
 *  cadence-only items. */
interface FlaggedItem {
  key: string
  title: string
  contact: Contact | undefined
  days: number // Infinity = never called
  tier: AttentionTier
  reason: string
  deal?: Deal
  /** The next scheduled meeting with this contact/deal, if any is booked. */
  upcomingAt?: string
}

/** A calendar event, linked to a contact and/or deal, happening this week. */
interface WeekMeeting {
  key: string
  event: CalendarEvent
  contact: Contact | undefined
  deal: Deal | undefined
}

function formatOverdue(days: number): string {
  if (!Number.isFinite(days)) return 'No calls yet'
  const whole = Math.floor(days)
  return `${whole} day${whole === 1 ? '' : 's'} since last call`
}

function formatUpcoming(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** The earliest future event linked to this deal/contact, or undefined —
 *  local calendar events only (the only kind that can carry a contactId/
 *  dealId link). */
function nextUpcomingEventAt(
  events: CalendarEvent[],
  contactId: string | undefined,
  dealId: string | undefined
): string | undefined {
  const now = Date.now()
  const matches = events.filter(
    (e) => (dealId && e.dealId === dealId) || (contactId && e.contactId === contactId)
  )
  const upcoming = matches
    .filter((e) => Date.parse(e.start) > now)
    .sort((a, b) => a.start.localeCompare(b.start))
  return upcoming[0]?.start
}

/** Every calendar event linked to a contact/deal happening in the next 7
 *  days — regardless of whether that contact/deal is flagged, so the rep can
 *  see the full week of what's already booked at a glance. */
function computeWeekMeetings(
  events: CalendarEvent[],
  contactById: Map<string, Contact>,
  dealById: Map<string, Deal>
): WeekMeeting[] {
  const now = Date.now()
  const weekMs = 7 * 24 * 60 * 60 * 1000
  return events
    .filter((e) => {
      if (!e.contactId && !e.dealId) return false
      const t = Date.parse(e.start)
      return t > now && t <= now + weekMs
    })
    .map((event) => ({
      key: `meeting-${event.id}`,
      event,
      contact: event.contactId ? contactById.get(event.contactId) : undefined,
      deal: event.dealId ? dealById.get(event.dealId) : undefined
    }))
    .sort((a, b) => a.event.start.localeCompare(b.event.start))
}

/** Every deal that needs attention (a medium/high risk assessment, or —
 *  when the cadence feature is on — gone quiet too long) AND every deal-less
 *  contact gone quiet, in one place: risk first, then most overdue. */
export function FollowUpDigest({
  onOpenDeal,
  onOpenContact
}: FollowUpDigestProps): React.JSX.Element {
  const { deals, loading: dealsLoading } = useDeals()
  const { stages, loading: stagesLoading } = useDealStages()
  const { contacts, loading: contactsLoading } = useContacts()
  const { settings } = useAppSettings()
  const { staleFollowUpEnabled, staleAfterDays } = settings.crm
  const { tasks, loading: tasksLoading, update: updateTask } = useTasks()
  const [calls, setCalls] = useState<CallSummary[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])

  useEffect(() => {
    let active = true
    void window.api.calls.list().then((list) => {
      if (active) setCalls(list)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    const load = (): void => {
      void window.api.events.list().then((list) => {
        if (active) setEvents(list)
      })
    }
    load()
    const off = window.api.events.onChanged(load)
    return () => {
      active = false
      off()
    }
  }, [])

  const loading = dealsLoading || stagesLoading || contactsLoading

  const flagged = useMemo<FlaggedItem[]>(() => {
    const contactStats = buildContactStats(calls)
    const stageById = new Map(stages.map((s) => [s.id, s]))
    const contactById = new Map(contacts.map((c) => [c.id, c]))
    const openDealContactIds = contactsWithOpenDeals(deals, stages)

    const dealItems: FlaggedItem[] = []
    for (const deal of deals) {
      const lastCallAt = contactStats.get(deal.contactId)?.lastCallAt
      const tier = dealAttentionTier(
        deal,
        stageById.get(deal.stageId),
        lastCallAt,
        staleFollowUpEnabled,
        staleAfterDays
      )
      if (!tier) continue
      const reason =
        tier === 'stale'
          ? formatOverdue(daysSinceLastCall(lastCallAt))
          : (deal.riskAssessment?.summary ?? '')
      dealItems.push({
        key: `deal-${deal.id}`,
        title: deal.title,
        contact: contactById.get(deal.contactId),
        days: daysSinceLastCall(lastCallAt),
        tier,
        reason,
        deal,
        upcomingAt: nextUpcomingEventAt(events, deal.contactId, deal.id)
      })
    }

    // Deal-less contacts: never double-flagged with a deal they already own.
    // Always cadence-based — a contact has no risk assessment of its own.
    const contactItems: FlaggedItem[] = contacts
      .filter((c) =>
        isContactStale(
          openDealContactIds.has(c.id),
          contactStats.get(c.id)?.lastCallAt,
          staleFollowUpEnabled,
          staleAfterDays,
          c.createdAt
        )
      )
      .map((contact) => {
        const days = daysSinceLastCall(contactStats.get(contact.id)?.lastCallAt)
        return {
          key: `contact-${contact.id}`,
          title: contact.name,
          contact,
          days,
          tier: 'stale' as const,
          reason: formatOverdue(days),
          upcomingAt: nextUpcomingEventAt(events, contact.id, undefined)
        }
      })

    return [...dealItems, ...contactItems].sort((a, b) => {
      const tierDiff = ATTENTION_TIER_RANK[a.tier] - ATTENTION_TIER_RANK[b.tier]
      if (tierDiff !== 0) return tierDiff
      // Explicit comparison — `b.days - a.days` is NaN when both are Infinity
      // ("no calls yet"), which makes the whole sort order unspecified.
      return a.days === b.days ? 0 : b.days > a.days ? 1 : -1
    })
  }, [deals, stages, contacts, calls, events, staleFollowUpEnabled, staleAfterDays])

  // Open tasks tied to a deal or contact — so a follow-up already on the
  // Tasks screen doesn't get lost. Soonest due date first (no due date last),
  // then priority. Independent of the risk/cadence flags above: a task stays
  // visible here until it's done, regardless of whether its deal/contact is
  // still flagged.
  const linkedTasks = useMemo<Task[]>(() => {
    const contactById = new Map(contacts.map((c) => [c.id, c]))
    const dealById = new Map(deals.map((d) => [d.id, d]))
    return tasks
      .filter(
        (t) =>
          t.status === 'open' &&
          ((t.contactId && contactById.has(t.contactId)) || (t.dealId && dealById.has(t.dealId)))
      )
      .sort((a, b) => {
        const dueDiff = (a.dueAt ? 0 : 1) - (b.dueAt ? 0 : 1)
        if (dueDiff !== 0) return dueDiff
        if (a.dueAt && b.dueAt && a.dueAt !== b.dueAt) return a.dueAt.localeCompare(b.dueAt)
        return PRIORITY_META[a.priority].rank - PRIORITY_META[b.priority].rank
      })
  }, [tasks, contacts, deals])

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])
  const dealById = useMemo(() => new Map(deals.map((d) => [d.id, d])), [deals])

  const weekMeetings = useMemo<WeekMeeting[]>(
    () => computeWeekMeetings(events, contactById, dealById),
    [events, contactById, dealById]
  )

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-1 flex items-baseline gap-2.5">
        <h2 className="text-lg font-semibold tracking-tight">Needs follow-up</h2>
        <span className="text-[13px] text-faint">
          {flagged.length} {flagged.length === 1 ? 'item' : 'items'}
        </span>
      </div>
      <p className="mb-5 text-[13px] text-faint">
        Open deals flagged medium/high risk, plus deals and deal-less contacts gone quiet past your
        Settings → CRM threshold — risk first, then most overdue.
        {!staleFollowUpEnabled && ' Cadence flagging is off, so only risk-flagged deals show here.'}
      </p>

      {loading ? (
        <div className="flex h-40 items-center justify-center text-sm text-faint">Loading…</div>
      ) : flagged.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
            <CheckCircle2 className="h-6 w-6 text-emerald-300" strokeWidth={1.75} />
          </div>
          <h3 className="text-lg font-semibold">Nothing needs attention</h3>
          <p className="mt-1.5 max-w-xs text-sm text-muted">
            {staleFollowUpEnabled
              ? 'Every open deal and contact has had a call within your threshold, and nothing is flagged high/medium risk.'
              : 'No deal is flagged medium/high risk. Cadence flagging is off in Settings → CRM.'}
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {flagged.map((item) => (
            <FollowUpRow
              key={item.key}
              item={item}
              onOpen={() =>
                item.deal
                  ? onOpenDeal(item.deal.id)
                  : item.contact && onOpenContact(item.contact.id)
              }
            />
          ))}
        </ul>
      )}

      {/* Open tasks tied to a deal/contact — separate from the flagged list
          above, since a task can be open regardless of risk/cadence state. */}
      {!tasksLoading && linkedTasks.length > 0 && (
        <div className="mt-8">
          <div className="mb-1 flex items-baseline gap-2.5">
            <h2 className="text-lg font-semibold tracking-tight">Open follow-up tasks</h2>
            <span className="text-[13px] text-faint">
              {linkedTasks.length} {linkedTasks.length === 1 ? 'item' : 'items'}
            </span>
          </div>
          <p className="mb-5 text-[13px] text-faint">
            Existing tasks tied to a deal or contact, still open — so a follow-up doesn&apos;t get
            lost.
          </p>
          <ul className="space-y-2.5">
            {linkedTasks.map((task) => (
              <LinkedTaskRow
                key={task.id}
                task={task}
                contact={task.contactId ? contactById.get(task.contactId) : undefined}
                deal={task.dealId ? dealById.get(task.dealId) : undefined}
                onDone={() => void updateTask(task.id, { status: 'done' })}
                onOpen={() => {
                  if (task.dealId && dealById.has(task.dealId)) onOpenDeal(task.dealId)
                  else if (task.contactId && contactById.has(task.contactId))
                    onOpenContact(task.contactId)
                }}
              />
            ))}
          </ul>
        </div>
      )}

      {/* Every meeting this week tied to a contact/deal — the calendar half of
          the picture, independent of whether that contact/deal is flagged. */}
      {weekMeetings.length > 0 && (
        <div className="mt-8">
          <div className="mb-1 flex items-baseline gap-2.5">
            <h2 className="text-lg font-semibold tracking-tight">This week&apos;s meetings</h2>
            <span className="text-[13px] text-faint">
              {weekMeetings.length} {weekMeetings.length === 1 ? 'item' : 'items'}
            </span>
          </div>
          <p className="mb-5 text-[13px] text-faint">
            Calendar events linked to a contact or deal, coming up in the next 7 days.
          </p>
          <ul className="space-y-2.5">
            {weekMeetings.map((meeting) => (
              <WeekMeetingRow
                key={meeting.key}
                meeting={meeting}
                onOpen={() => {
                  if (meeting.deal) onOpenDeal(meeting.deal.id)
                  else if (meeting.contact) onOpenContact(meeting.contact.id)
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

interface WeekMeetingRowProps {
  meeting: WeekMeeting
  onOpen: () => void
}

function WeekMeetingRow({ meeting, onOpen }: WeekMeetingRowProps): React.JSX.Element {
  const { event, contact, deal } = meeting

  return (
    <li className="flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-medium">{event.title}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
          <span className="flex items-center gap-1 text-sky-300">
            <CalendarClock className="h-3 w-3" /> {formatUpcoming(event.start)}
          </span>
          {(deal || contact) && (
            <span className="flex items-center gap-1">
              <Building2 className="h-3 w-3" /> {deal ? deal.title : contact?.name}
              {deal && contact?.name ? ` · ${contact.name}` : ''}
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

interface LinkedTaskRowProps {
  task: Task
  contact: Contact | undefined
  deal: Deal | undefined
  onDone: () => void
  onOpen: () => void
}

function LinkedTaskRow({
  task,
  contact,
  deal,
  onDone,
  onOpen
}: LinkedTaskRowProps): React.JSX.Element {
  const typeMeta = TASK_TYPE_META[task.type]
  const priorityMeta = PRIORITY_META[task.priority]
  const due = formatDueLabel(task.dueAt)
  const TypeIcon = typeMeta.icon

  return (
    <li className="flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5">
      <button
        type="button"
        onClick={onDone}
        title="Mark as done"
        className="mt-0.5 shrink-0 text-faint transition hover:text-accent"
      >
        <Circle className="h-5 w-5" />
      </button>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className="truncate text-sm font-medium">{task.title}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
          <span className="flex items-center gap-1">
            <TypeIcon className="h-3 w-3" /> {typeMeta.label}
          </span>
          <span
            className={cn(
              'rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
              priorityMeta.badge
            )}
          >
            {priorityMeta.label}
          </span>
          {due && <span className={DUE_TONE_CLASS[due.tone]}>{due.text}</span>}
          {(deal || contact) && (
            <span className="flex items-center gap-1">
              <Building2 className="h-3 w-3" /> {deal ? deal.title : contact?.name}
              {deal && contact?.name ? ` · ${contact.name}` : ''}
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

interface FollowUpRowProps {
  item: FlaggedItem
  onOpen: () => void
}

function FollowUpRow({ item, onOpen }: FollowUpRowProps): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<'created' | 'exists' | 'error' | null>(null)
  const created = result === 'created' || result === 'exists'
  const { deal, contact, title, days, tier, reason, upcomingAt } = item
  const value = deal ? formatValue(deal.value) : null
  const isRiskTier = tier === 'risk-high' || tier === 'risk-medium'

  const handleCreate = async (): Promise<void> => {
    setCreating(true)
    setResult(null)
    try {
      if (deal) setResult(await createFollowUpTask(deal, contact?.name))
      else if (contact) setResult(await createContactFollowUpTask(contact.id, contact.name))
    } catch {
      setResult('error')
    } finally {
      setCreating(false)
    }
  }

  return (
    <li className="flex items-start gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5">
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium">{title}</p>
          {isRiskTier && (
            <span
              className={cn(
                'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                RISK_TIER_CLASS[tier as 'risk-high' | 'risk-medium']
              )}
            >
              {RISK_TIER_LABEL[tier as 'risk-high' | 'risk-medium']}
            </span>
          )}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
          {deal && (
            <span className="flex items-center gap-1">
              <Building2 className="h-3 w-3" /> {contact?.name ?? 'Unknown contact'}
              {contact?.company ? ` · ${contact.company}` : ''}
            </span>
          )}
          {!deal && contact?.company && (
            <span className="flex items-center gap-1">
              <Building2 className="h-3 w-3" /> {contact.company}
            </span>
          )}
          {value && <span className="font-medium text-ink">{value}</span>}
          {!deal && (
            <span className="rounded-full border border-line-soft bg-canvas px-1.5 py-0.5 text-faint">
              No open deal
            </span>
          )}
          {isRiskTier && Number.isFinite(days) && (
            <span className="flex items-center gap-1">
              <PhoneCall className="h-3 w-3" /> {formatOverdue(days)}
            </span>
          )}
        </div>
        <p
          className={cn(
            'mt-1.5 flex items-start gap-1.5 text-[12px]',
            isRiskTier ? 'text-muted' : 'font-medium text-amber-300'
          )}
        >
          {isRiskTier ? (
            <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0 text-faint" />
          ) : (
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          )}
          {reason}
        </p>
        {upcomingAt && (
          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-sky-300">
            <CalendarClock className="h-3 w-3 shrink-0" />
            Already booked: {formatUpcoming(upcomingAt)}
          </p>
        )}
      </button>

      <div className="flex shrink-0 items-center gap-2">
        {created ? (
          <span className="flex items-center gap-1 text-[12px] font-medium text-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {result === 'exists' ? 'Already on Tasks' : 'Task created'}
          </span>
        ) : (
          <>
            {result === 'error' && (
              <span className="text-[12px] text-rose-300">Couldn&apos;t create — try again</span>
            )}
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={creating}
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink disabled:opacity-50"
            >
              <ListPlus className="h-3.5 w-3.5" /> {creating ? 'Creating…' : 'Create task'}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-ink"
        >
          <PhoneCall className="h-3.5 w-3.5" /> Open
        </button>
      </div>
    </li>
  )
}
