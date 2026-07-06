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
