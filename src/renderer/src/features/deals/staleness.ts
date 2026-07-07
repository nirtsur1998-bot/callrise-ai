import { isStale } from '@renderer/features/contacts/contactStats'
import type { Deal, DealStage } from './types'

/** A deal needs follow-up flagging only when the feature is on (Settings →
 *  CRM) AND it's still an open (not Won/Lost) deal — a closed deal going
 *  quiet isn't something to chase. */
export function isDealStale(
  stage: DealStage | undefined,
  lastCallAt: string | undefined,
  enabled: boolean,
  staleAfterDays: number,
  /** The deal's createdAt — a never-called deal only counts as stale once the
   *  RECORD itself is older than the threshold, so a deal added today isn't
   *  instantly flagged "no calls in over N days". */
  fallbackAnchor?: string
): boolean {
  if (!enabled) return false
  if (!stage || stage.kind !== 'open') return false
  return isStale(lastCallAt ?? fallbackAnchor, staleAfterDays)
}

/** Every contact that owns at least one OPEN (not Won/Lost) deal — those
 *  contacts are never separately flagged, since their deal already carries
 *  the follow-up flag. Phase 4 Step 3 only extends flagging to contacts with
 *  no open deal at all. */
export function contactsWithOpenDeals(deals: Deal[], stages: DealStage[]): Set<string> {
  const openStageIds = new Set(stages.filter((s) => s.kind === 'open').map((s) => s.id))
  const knownStageIds = new Set(stages.map((s) => s.id))
  const ids = new Set<string>()
  for (const deal of deals) {
    // A deal in an UNKNOWN stage (reset/hand-edited stage list) counts as
    // open — we don't know it's closed, and its contact shouldn't be flagged
    // "no open deal" because of a config problem.
    if (openStageIds.has(deal.stageId) || !knownStageIds.has(deal.stageId)) {
      ids.add(deal.contactId)
    }
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
  staleAfterDays: number,
  /** The contact's createdAt — see isDealStale: a contact added today must
   *  not be instantly flagged. */
  fallbackAnchor?: string
): boolean {
  if (!enabled || hasOpenDeal) return false
  return isStale(lastCallAt ?? fallbackAnchor, staleAfterDays)
}

export type FollowUpTaskResult = 'created' | 'exists'

/** True when an identical follow-up is already open on the Tasks screen —
 *  the "Task created" state is per-mount UI state, so without this check
 *  opening the digest twice in a week minted duplicate tasks. */
async function hasOpenTaskTitled(title: string): Promise<boolean> {
  try {
    const tasks = await window.api.tasks.list()
    return tasks.some((t) => t.title === title && t.status === 'open')
  } catch {
    return false // can't check — creating a possible duplicate beats failing
  }
}

/** Creates a real task in the existing Tasks screen — the one-tap action on
 *  a flagged deal, shared by the deal detail view and the follow-up digest.
 *  Skips creation when the same open follow-up already exists. */
export async function createFollowUpTask(
  deal: Deal,
  contactName: string | undefined
): Promise<FollowUpTaskResult> {
  const title = `Follow up with ${contactName ?? 'contact'} — ${deal.title}`
  if (await hasOpenTaskTitled(title)) return 'exists'
  await window.api.tasks.create({
    title,
    type: 'follow-up',
    priority: 'medium',
    clientName: contactName ?? null,
    note: `Deal: ${deal.title}`,
    source: 'manual'
  })
  return 'created'
}

/** Same action for a flagged contact that has no deal to hang the task off of. */
export async function createContactFollowUpTask(contactName: string): Promise<FollowUpTaskResult> {
  const title = `Follow up with ${contactName}`
  if (await hasOpenTaskTitled(title)) return 'exists'
  await window.api.tasks.create({
    title,
    type: 'follow-up',
    priority: 'medium',
    clientName: contactName,
    source: 'manual'
  })
  return 'created'
}
