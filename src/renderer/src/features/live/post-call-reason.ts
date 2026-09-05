// M34 3e — the reason prompt at call end.
//
// M32 Stage 2 asks "what do you think won/lost it?" on the board, the moment a
// deal is dragged into a closed stage. 3e offers the SAME capture at the other
// moment the answer is fresh: the call just ended, on a contact whose deal is
// already closed and has no reason yet. Same component, same skip streak, same
// rules — skippable in one action, never blocking, and if it is skipped
// consistently the app says so once and stops (outcomeReasonPref.ts).
//
// Extracted as a pure decision because LiveView cannot be render-tested
// (BUG-140): everything that can be wrong lives here, where a test reaches it.
// CORRECTION 2026-09-05: components CAN be render-tested here — see live-header-pieces.render.test.ts (`@vitest-environment happy-dom`, react-dom/client, a `.test.ts` file). The pure/UI split below still stands on its own merits; it is no longer forced.
import type { Deal, DealStage } from '@renderer/features/deals/types'
import { promptRetired, shouldAnnounceStopping } from '@renderer/features/deals/outcomeReasonPref'

export type PostCallReasonDecision =
  | {
      kind: 'prompt'
      dealId: string
      dealTitle: string
      /** The closed kind — decides the question asked. */
      end: 'won' | 'lost' | 'went-quiet'
      stageLabel: string
    }
  /** The streak hit its limit: say so once, then nothing. */
  | { kind: 'retired-notice' }
  | { kind: 'none' }

export interface PostCallReasonInput {
  /** The deal the ended call belongs to — the saved call's own link first,
   *  the matched meeting's deal second. Undefined when neither exists: no
   *  prompt, and no attempt to guess a deal from a name. */
  deal: Deal | undefined
  stage: DealStage | undefined
}

/** Decide, from records only, whether the ended call earns the prompt. */
export function decidePostCallReason(
  input: PostCallReasonInput,
  pref: { retired: () => boolean; announceStopping: () => boolean } = {
    retired: promptRetired,
    announceStopping: shouldAnnounceStopping
  }
): PostCallReasonDecision {
  const { deal, stage } = input
  if (!deal || !stage) return { kind: 'none' }
  if (stage.kind === 'open') return { kind: 'none' } // still in play: nothing ended
  if (deal.outcomeReason && deal.outcomeReason.trim().length > 0) return { kind: 'none' } // already answered
  if (pref.retired()) {
    // The app has stopped asking. Say so exactly once (the pref remembers),
    // then be silent — silence alone reads as "it broke".
    return pref.announceStopping() ? { kind: 'retired-notice' } : { kind: 'none' }
  }
  return {
    kind: 'prompt',
    dealId: deal.id,
    dealTitle: deal.title,
    end: stage.kind,
    stageLabel: stage.label
  }
}

/**
 * Resolve the ended call's deal and decide. The saved call's own `dealId` is
 * the strongest link (the rep set it, or an earlier answer did); the matched
 * meeting's deal is the fallback the live surface already trusts for 3d.
 */
export async function resolvePostCallReason(
  savedCallId: string,
  meetingDealId: string | undefined,
  api: {
    getCall: (id: string) => Promise<{ dealId?: string } | null>
    listDeals: () => Promise<Deal[]>
    getStages: () => Promise<DealStage[]>
  } = {
    getCall: (id) => window.api.calls.get(id),
    listDeals: () => window.api.deals.list(),
    getStages: () => window.api.dealStages.get()
  }
): Promise<PostCallReasonDecision> {
  try {
    const call = await api.getCall(savedCallId)
    const dealId = call?.dealId || meetingDealId
    if (!dealId) return { kind: 'none' }
    const [deals, stages] = await Promise.all([api.listDeals(), api.getStages()])
    const deal = deals.find((d) => d.id === dealId)
    const stage = deal ? stages.find((s) => s.id === deal.stageId) : undefined
    return decidePostCallReason({ deal, stage })
  } catch {
    // A failed lookup means no prompt — never a prompt about a guessed deal.
    return { kind: 'none' }
  }
}
