import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

/**
 * M35 — the app's one tooltip primitive (M31's Stage 1 leftover).
 *
 * WHAT IT REPLACES. Native `title=` attributes: a delay the OS decides, a
 * plain-system look that ignores the theme, nothing on keyboard focus, and
 * nothing at all on touch. This shows the same words as a styled popover on
 * hover AND on focus, after a short delay, and reads them to assistive tech
 * through Radix's own aria wiring.
 *
 * WHAT IT DOES NOT REPLACE (founder's call, 2026-09-05): truncation reveals
 * (`title={item.title}` on a `truncate` element — the browser does that
 * better) and short dynamic values (a country name, a status dot's label).
 * Those stay native on purpose; count them in the classification test before
 * "cleaning them up".
 *
 * USAGE. Wrap the element the words are ABOUT. The child must be a single
 * element that takes a ref and pointer/focus handlers (a button, an anchor, a
 * span, a div — any DOM element or a component that forwards them):
 *
 *   <Tooltip content="Opens the provider's own data-usage terms">
 *     <a href=…>…</a>
 *   </Tooltip>
 *
 * A control that shows only an icon still needs its own `aria-label`: the
 * tooltip describes, it does not name.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  className,
  disabled = false
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  /** Extra classes for the popover, e.g. a wider max width for a sentence. */
  className?: string
  /** Render the child alone (no tooltip) — for a site that is conditionally worded. */
  disabled?: boolean
}): React.JSX.Element {
  if (disabled || content === null || content === undefined || content === '') return <>{children}</>
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'z-[70] max-w-xs rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-[12px] leading-snug text-ink shadow-lg',
            'data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0',
            className
          )}
        >
          {content}
          <RadixTooltip.Arrow className="fill-elevated" width={10} height={5} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}

/** Mount ONCE at the app root (App.tsx). Every <Tooltip> below it shares the
 *  delay and the "once one is open, the next opens instantly" behaviour. */
export function TooltipProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={250}>
      {children}
    </RadixTooltip.Provider>
  )
}
