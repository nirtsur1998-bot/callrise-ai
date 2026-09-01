import { useEffect, useState, type RefObject } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

/**
 * "Take me to the bottom" for any scrollable region.
 *
 * ONE implementation, applied at the two places scrolling actually happens —
 * AppShell's main column (which every ordinary page scrolls inside) and the
 * handful of full-bleed screens that own their own scroller. Enumerating
 * "pages that are long" would have been a list that goes stale the first time
 * someone adds a long page; attaching to the containers means a new page
 * inherits it without knowing this component exists.
 *
 * It renders NOTHING when there is nowhere to go — but "nowhere to go" now
 * means "already at the bottom", not "within a screen of it".
 *
 * BUG-156 (founder, 2026-09-01), OVERRIDING THIS FILE'S ORIGINAL REASONING,
 * quoted here because the trade-off is real and someone should be able to see
 * it was considered rather than missed:
 *
 *     "It renders NOTHING unless there is somewhere to go. A control that is
 *      always present and sometimes inert teaches people to ignore it, and the
 *      threshold below is deliberately much larger than 'not exactly at the
 *      bottom': this is for pages long enough that scrolling is a chore, not
 *      for the last inch."
 *
 * That optimises for the control not becoming noise. The founder stated the
 * opposite priority directly: "this go down arrow should be possible to click
 * on no matter which point of the page I am at — top/middle — like you have
 * here in Claude. THIS IS THE REAL FIX."
 *
 * And the original reasoning had a cost it did not price: a control that is
 * USUALLY present and sometimes silently absent is worse than one that is
 * always present. The first teaches people it is unreliable; the second only
 * that it is occasionally redundant. At a full screen of tolerance the button
 * disappeared for the entire last screen of every page — measured, at
 * scrollTop 600 with 128px remaining — which reads as broken, not restrained.
 */

/** Offer the jump whenever the user is not effectively AT the bottom.
 *
 *  Not zero: sub-pixel layout, fractional device pixels and momentum scrolling
 *  routinely leave a few pixels of remainder at the true bottom, so a literal
 *  "greater than nothing" test would leave the button flickering on at rest.
 *  A small tolerance is "at the bottom" in every sense a user has, while being
 *  far below the one-screen gap that made it vanish where it was wanted. */
const MIN_REMAINING_PX = 16

export function ScrollToEnd({
  targetRef,
  label = 'Jump to the bottom',
  className
}: {
  /** The element that actually scrolls. Its parent must be positioned. */
  targetRef: RefObject<HTMLElement | null>
  label?: string
  className?: string
}): React.JSX.Element | null {
  const [show, setShow] = useState(false)

  useEffect(() => {
    const el = targetRef.current
    if (!el) return

    const update = (): void => {
      setShow(el.scrollHeight - el.scrollTop - el.clientHeight > MIN_REMAINING_PX)
    }
    update()

    el.addEventListener('scroll', update, { passive: true })

    // Two observers, because two different things change the answer and only
    // one of them is a scroll: the VIEWPORT resizing (window drag, sidebar
    // collapse) and the CONTENT growing (a summary arrives, a list loads, a
    // section expands). Watching only the scroller misses content growth,
    // which is exactly when a page becomes long enough to need this.
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)

    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [targetRef])

  if (!show) return null

  return (
    <button
      type="button"
      onClick={() => {
        const el = targetRef.current
        if (!el) return
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      }}
      aria-label={label}
      title={label}
      className={cn(
        'absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full',
        'border border-line bg-elevated p-2 text-muted shadow-pop',
        // Motion from the shared vocabulary, not a one-off curve.
        'transition-colors hover:bg-surface hover:text-ink',
        className
      )}
    >
      <ChevronDown className="h-4 w-4" strokeWidth={2.25} />
    </button>
  )
}
