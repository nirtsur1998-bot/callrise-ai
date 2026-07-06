import { isStale } from '@renderer/features/contacts/contactStats'
import type { DealStage } from './types'

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
