import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

interface CollapseTransitionProps {
  /** false collapses this row to zero height; onCollapsed fires once that
   *  animation actually finishes, not the instant the prop flips. */
  open: boolean
  onCollapsed?: () => void
  children: ReactNode
  className?: string
}

/**
 * A CSS grid-rows collapse, not a conditional unmount. Something that closes
 * this way reads as an event — the rep dismissed it, or a grace window ran
 * out — rather than a row that blinked out of existence mid-frame, which is
 * the difference between a live HUD that feels considered and one that just
 * flickers. `grid-template-rows` animating between `1fr` and `0fr` is the
 * only CSS-only way to transition an element whose height is otherwise
 * `auto`, and because it's a plain transition rather than a bespoke
 * keyframe, it inherits index.css's blanket prefers-reduced-motion override
 * for free (that rule forces transition-duration toward 0 on every element)
 * — a reduced-motion user gets the identical collapse, just effectively
 * instant, with no separate JS branch needed here.
 */
export function CollapseTransition({
  open,
  onCollapsed,
  children,
  className
}: CollapseTransitionProps): React.JSX.Element {
  return (
    <div
      className={cn('grid transition-[grid-template-rows] duration-200 ease-out', className)}
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      // Collapsed content is visually zero-height but not guaranteed to be
      // pruned from the accessibility tree by CSS alone — aria-hidden makes
      // that explicit, which matters most for the evidence-disclosure case
      // (a screen reader shouldn't see a quote that's currently collapsed
      // behind an aria-expanded=false toggle) and is harmless everywhere
      // else this wrapper is used.
      aria-hidden={!open}
      onTransitionEnd={(event) => {
        if (
          !open &&
          event.target === event.currentTarget &&
          event.propertyName === 'grid-template-rows'
        ) {
          onCollapsed?.()
        }
      }}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  )
}
