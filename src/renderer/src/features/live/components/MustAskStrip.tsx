import { Tooltip } from '@renderer/components/Tooltip'
import { Check } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { MUST_ASK, type ChecklistState } from '../checklist/must-ask'

/**
 * The must-ask checklist, as ambient progress (§4.5).
 *
 * Deliberately the quietest thing on the live screen. It fills in as the call
 * goes and says nothing at all until the rep is about to hang up — a checklist
 * that interrupts to say "you haven't asked about budget" while the buyer is
 * mid-sentence about budget is worse than no checklist.
 *
 * Covered items go muted rather than bold. The eye should land on what is
 * still OUTSTANDING, which is the opposite of how a progress list usually
 * wants to draw itself.
 */
export function MustAskStrip({ state }: { state: ChecklistState }): React.JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      aria-label={`Discovery checklist, ${state.covered.size} of ${MUST_ASK.length} covered`}
    >
      {MUST_ASK.map((item) => {
        const covered = state.covered.has(item.id)
        return (
          <Tooltip key={item.id} content={covered ? `${item.label} — covered` : `${item.label} — not yet`}>
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors',
                covered ? 'bg-positive-soft text-positive' : 'border border-line-soft text-faint'
              )}
            >
              {covered && <Check className="h-3 w-3" aria-hidden="true" />}
              {item.label}
            </span>
          </Tooltip>
        )
      })}
    </div>
  )
}
