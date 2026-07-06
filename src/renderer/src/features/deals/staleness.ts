import { isStale } from '@renderer/features/contacts/contactStats'
import type { Deal, DealStage } from './types'

/** A deal needs follow-up flagging only when the feature is on (Settings →
 *  CRM) AND it's still an open (not Won/Lost) deal — a closed deal going
 *  quiet isn't something to chase. */
export function isDealStale(
  stage: DealStage | undefined,
  lastCallAt: string | undefined,
  enabled: boolean,
  staleAfterDays: number
): boolean {
  if (!enabled) return false
  if (!stage || stage.kind !== 'open') return false
  return isStale(lastCallAt, staleAfterDays)
}

/** Every contact that owns at least one OPEN (not Won/Lost) deal — those
 *  contacts are never separately flagged, since their deal already carries
 *  the follow-up flag. Phase 4 Step 3 only extends flagging to contacts with
 *  no open deal at all. */
export function contactsWithOpenDeals(deals: Deal[], stages: DealStage[]): Set<string> {
  const openStageIds = new Set(stages.filter((s) => s.kind === 'open').map((s) => s.id))
  const ids = new Set<string>()
  for (const deal of deals) {
    if (openStageIds.has(deal.stageId)) ids.add(deal.contactId)
  }
  return ids
}

/** A contact needs follow-up flagging when the feature is on, they have NO
 *  open deal (which would already be flagged on its own), and they've gone
 *  quiet longer than the threshold. */
export function isContactStale(
  hasOpenDeal: boolean,
  lastCallAt: string | undefined,
  enabled: boolean,
  staleAfterDays: number
): boolean {
  if (!enabled || hasOpenDeal) return false
  return isStale(lastCallAt, staleAfterDays)
}

/** Creates a real task in the existing Tasks screen — the one-tap action on
 *  a flagged deal, shared by the deal detail view and the follow-up digest. */
export async function createFollowUpTask(
  deal: Deal,
  contactName: string | undefined
): Promise<void> {
  await window.api.tasks.create({
    title: `Follow up with ${contactName ?? 'contact'} — ${deal.title}`,
    type: 'follow-up',
    priority: 'medium',
    clientName: contactName ?? null,
    note: `Deal: ${deal.title}`,
    source: 'manual'
  })
}

/** Same action for a flagged contact that has no deal to hang the task off of. */
export async function createContactFollowUpTask(contactName: string): Promise<void> {
  await window.api.tasks.create({
    title: `Follow up with ${contactName}`,
    type: 'follow-up',
    priority: 'medium',
    clientName: contactName,
    source: 'manual'
  })
}
