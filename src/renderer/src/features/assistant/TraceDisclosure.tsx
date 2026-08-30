import { useState } from 'react'
import { ChevronRight, Check, CircleSlash, TriangleAlert, MinusCircle } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { AssistantTraceStep } from '../../../../preload/index.d'
import { traceSummary, traceHasGaps } from './traceSummary'

/**
 * M31 Stage 5 item 4 — "why did the AI say that", answered from what the turn
 * actually did.
 *
 * Founder's three constraints, and where each one lives:
 *   1. What HAPPENED, never what was planned — enforced in main, which builds
 *      these steps from executeLookups' outcomes rather than from the plan.
 *      Empty and failed lookups appear saying so.
 *   2. Default collapsed, one-line summary, click to expand — here.
 *   3. No animation drama on open — here, and deliberately: this is a
 *      disclosure someone opens because an answer surprised them, and making
 *      them wait through a transition to read it is the wrong trade. The rows
 *      simply exist. The one motion is the chevron, on the shared press/settle
 *      curve like every other control.
 */

const STATUS_ICON = {
  ok: Check,
  none: CircleSlash,
  failed: TriangleAlert,
  skipped: MinusCircle
} as const

const STATUS_CLASS = {
  ok: 'text-positive',
  // Not a warning colour. "I looked and there was nothing" is a normal,
  // honest outcome — colouring it as a problem would train people to read a
  // complete answer as a broken one.
  none: 'text-faint',
  failed: 'text-warning',
  skipped: 'text-faint'
} as const

export function TraceDisclosure({ steps }: { steps: AssistantTraceStep[] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null

  const gaps = traceHasGaps(steps)

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] transition-colors',
          'hover:bg-elevated',
          gaps ? 'text-muted' : 'text-faint'
        )}
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')}
          strokeWidth={2.5}
        />
        {traceSummary(steps)}
      </button>

      {open && (
        <ul className="mt-1 flex flex-col gap-1 border-l border-line-soft py-1 pl-3 ml-2.5">
          {steps.map((step, i) => {
            const Icon = STATUS_ICON[step.status]
            return (
              <li key={i} className="flex items-start gap-2 text-[12px]">
                <Icon
                  className={cn('mt-0.5 h-3 w-3 shrink-0', STATUS_CLASS[step.status])}
                  strokeWidth={2.25}
                />
                <span className="min-w-0">
                  <span className="text-muted">{step.label}</span>
                  {step.detail && <span className="text-faint"> · {step.detail}</span>}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
