import type { Contact } from '@renderer/features/contacts/types'
import type { Deal } from '@renderer/features/deals/types'
import type { DealStage } from '@renderer/features/deals/types'
import { dealAttentionTier } from '@renderer/features/deals/staleness'
import type { PrepBriefStatus } from '../../../../preload/index.d'
import type { CalendarItem } from './types'

/** The sales context a calendar chip can carry. Every field is optional and
 *  only ever set from data we actually have — an absent field renders
 *  nothing rather than a placeholder, so the chip can never imply a link
 *  that doesn't exist. */
export interface ChipContext {
  /** The linked contact's name — "who is this meeting with". */
  contactName?: string
  /** The linked deal's stage label, e.g. "Proposal". */
  dealStage?: string
  /** Only the two RISK tiers, never the staleness ones — see resolveRisk. */
  risk?: 'high' | 'medium'
  /** Omitted entirely for meetings that can't have a brief (a task, a past
   *  meeting, an event with no contact/deal link). */
  brief?: PrepBriefStatus
  /** M31 Slice B — the call recorded during this meeting, when one exists.
   *  Present ONLY from the hard link written at call-save time, so its
   *  presence is a fact rather than a match confidence. There is deliberately
   *  no "probably this call" variant: see CalendarEvent.callId. */
  callId?: string
}

export interface ChipContextSources {
  contactById: Map<string, Contact>
  dealById: Map<string, Deal>
  stageById: Map<string, DealStage>
  briefStatusByEventId: Map<string, PrepBriefStatus>
}

/**
 * Which risk marker, if any, a deal earns on a calendar chip.
 *
 * Deliberately routed through dealAttentionTier rather than reading
 * `deal.riskAssessment.level` directly, so "risk" means exactly the same
 * thing here as it does on the follow-up dashboard — one definition, not two
 * that drift. The two staleness tiers it can also return (`risk-stale`,
 * `stale`) are ignored on purpose: they depend on call history and the
 * cadence setting, which the calendar doesn't load, and a "hasn't been
 * called in a while" nudge is the follow-up digest's job, not a meeting
 * chip's. Passing `cadenceEnabled: false` makes the `stale` branch
 * unreachable rather than leaving it to be filtered afterwards.
 */
export function resolveRisk(deal: Deal, stage: DealStage | undefined): 'high' | 'medium' | undefined {
  const tier = dealAttentionTier(deal, stage, undefined, false, 0)
  if (tier === 'risk-high') return 'high'
  if (tier === 'risk-medium') return 'medium'
  return undefined
}

/**
 * M31 Slice B — the sales context for one calendar item.
 *
 * Returns undefined (no context at all) rather than an empty object when
 * there's nothing to show, so callers can skip rendering entirely instead of
 * reserving space for something that never arrives.
 *
 * Only `event` items can carry context. A task chip has no meeting identity
 * to hang a contact/deal/brief on, and Google/Outlook overlay items aren't
 * locally linked, so they'd only ever produce blanks.
 */
export function buildChipContext(
  item: CalendarItem,
  sources: ChipContextSources
): ChipContext | undefined {
  if (item.kind !== 'event') return undefined
  const event = item.event
  if (!event) return undefined

  const contact = event.contactId ? sources.contactById.get(event.contactId) : undefined
  const deal = event.dealId ? sources.dealById.get(event.dealId) : undefined
  const stage = deal ? sources.stageById.get(deal.stageId) : undefined

  const context: ChipContext = {}
  if (contact?.name) context.contactName = contact.name
  if (stage?.label) context.dealStage = stage.label
  if (deal) {
    const risk = resolveRisk(deal, stage)
    if (risk) context.risk = risk
  }

  // The brief dot is only meaningful for a meeting that is still ahead and
  // has something to brief ON. A brief for a meeting that already happened
  // is not actionable, and one with no contact/deal link would be generated
  // from nothing — in both cases showing a dot would invite a click that
  // can't pay off.
  const status = sources.briefStatusByEventId.get(event.id)
  if (status && status !== 'none' && (contact || deal)) context.brief = status

  // The outcome side of the same chip. No time check and no eligibility
  // rules here: the link only exists because a call was actually recorded
  // during this meeting, so its presence already means "this happened".
  if (event.callId) context.callId = event.callId

  return Object.keys(context).length > 0 ? context : undefined
}

/** Which calendar items are worth asking main for a brief status about —
 *  future, locally-linked meetings only. Keeping this in one place means the
 *  IPC batch and the render agree on scope by construction. */
export function briefEligibleEvents(items: CalendarItem[], now: Date): CalendarItem[] {
  return items.filter(
    (item) =>
      item.kind === 'event' &&
      item.event !== undefined &&
      item.start.getTime() >= now.getTime() &&
      (Boolean(item.event.contactId) || Boolean(item.event.dealId))
  )
}
