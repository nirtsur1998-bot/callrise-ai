import { useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@renderer/lib/cn'
import { useModalA11y } from '@renderer/lib/useModalA11y'

interface ModalProps {
  onClose: () => void
  children: ReactNode
  /** Accessible dialog title (wired to aria-labelledby). Omit if the panel
   *  renders its own labelled heading and passes labelledBy instead. */
  title?: string
  labelledBy?: string
  /** Max width of the panel. */
  /** Derived from SIZE below rather than hand-written, so adding a size to
   *  the map cannot leave the prop type behind — the exact silent divergence
   *  DealStageKind hit across three files this milestone. */
  size?: keyof typeof SIZE
  /** Skip auto-focusing the first field (dialogs with their own autoFocus). */
  initialFocus?: boolean
  className?: string
}

// '2xl' added for the outcome backfill: a fifteen-row work surface, not a
// confirmation. At max-w-2xl each row's five answer buttons wrapped onto a
// second line, tripling row height and cutting the visible rows from ~8 to
// ~3 — which turns one sitting into a scroll-click-scroll-click sitting.
// Density is a tenth-row concern, so the container has to give the row a
// single line. (cn() is a plain join with no tailwind-merge, so overriding
// max-w from the caller's className would be order-dependent and silent.)
const SIZE = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-2xl',
  '2xl': 'max-w-4xl'
} as const

/**
 * The one modal shell — owns the scrim, centered panel, backdrop-close, and
 * (via useModalA11y) focus-trap, Escape, focus restoration, and scroll-lock,
 * with a scrim-fade + panel-pop entrance. Every dialog wraps its content in
 * this instead of re-implementing the overlay.
 */
export function Modal({
  onClose,
  children,
  title,
  labelledBy,
  size = 'md',
  initialFocus = true,
  className
}: ModalProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const headingId = useId()
  useModalA11y(panelRef, onClose, initialFocus)

  // Rendered into document.body via a portal, NOT in place in the React tree.
  // `position: fixed` only escapes the whole window when every ancestor lacks
  // a transform/filter/animation of those properties — the app's own
  // page-transition animation (MainApp's `.animate-view`, which animates
  // `transform`) makes that ancestor a "containing block", which silently
  // repositioned (and clipped) the modal relative to a small scrolling
  // content div instead of the real viewport. A portal makes the modal immune
  // to that regardless of where in the tree it's opened from.
  // BUG-047: close on backdrop click by checking the click landed EXACTLY on
  // the backdrop element itself, not by stopping the panel's own mousedown
  // from bubbling. The old approach (stopPropagation() on the panel) had a
  // real, confirmed cost: it also silently absorbed every content picker's
  // (ContactPicker, CountrySelect) own document-level "click outside to
  // close" listener for ANY click elsewhere inside the same dialog, not
  // just genuine backdrop clicks — see those components' own BUG-047
  // comments. This is the standard, more robust pattern for exactly this
  // "backdrop closes, content doesn't" requirement: nothing needs to be
  // stopped, because a click on any DESCENDANT of the backdrop (the panel,
  // or anything in it) can never satisfy `e.target === e.currentTarget`.
  const closeIfClickedBackdrop = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) onClose()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      onMouseDown={closeIfClickedBackdrop}
    >
      <div
        className="animate-scrim absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onMouseDown={closeIfClickedBackdrop}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title ? headingId : undefined)}
        className={cn(
          'animate-pop relative w-full overflow-hidden rounded-2xl border border-line bg-surface shadow-pop',
          SIZE[size],
          className
        )}
      >
        {title && (
          <h2 id={headingId} className="sr-only">
            {title}
          </h2>
        )}
        {children}
      </div>
    </div>,
    document.body
  )
}
