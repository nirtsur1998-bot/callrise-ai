import {
  OutcomeReasonPrompt,
  OutcomeReasonRetiredNotice
} from '@renderer/features/deals/OutcomeReasonPrompt'
import { noteAnswered, noteSkip } from '@renderer/features/deals/outcomeReasonPref'
import type { PostCallReasonDecision } from '../post-call-reason'

/**
 * M34 3e — the reason prompt, under the "This call has ended" banner.
 *
 * Reuses M32 Stage 2's prompt and its retired notice unchanged, so both
 * surfaces ask the same question, count skips on the same streak, and stop
 * together. Inline, not modal: the Done button beside it still works, the
 * transcript stays readable underneath, and ignoring it costs nothing.
 *
 * `onDone` fires after a save, a skip, or dismissing the notice — the parent
 * clears its decision so the prompt cannot come back for the same call.
 */
export function PostCallReasonBanner({
  decision,
  onDone,
  saveReason = (dealId, reason) => window.api.deals.update(dealId, { outcomeReason: reason })
}: {
  decision: PostCallReasonDecision | null
  onDone: () => void
  saveReason?: (dealId: string, reason: string) => Promise<unknown>
}): React.JSX.Element | null {
  if (!decision || decision.kind === 'none') return null
  if (decision.kind === 'retired-notice') {
    return <OutcomeReasonRetiredNotice onDismiss={onDone} />
  }
  return (
    <div data-testid="post-call-reason">
      <OutcomeReasonPrompt
        key={decision.dealId}
        dealTitle={decision.dealTitle}
        kind={decision.end}
        stageLabel={decision.stageLabel}
        onSave={(reason) => {
          void saveReason(decision.dealId, reason).catch(() => {})
          noteAnswered()
          onDone()
        }}
        onSkip={() => {
          noteSkip()
          onDone()
        }}
      />
    </div>
  )
}
