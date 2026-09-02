import { useRef, type ReactNode } from 'react'
import { ScrollToEnd } from '@renderer/components/ScrollToEnd'
import { cn } from '@renderer/lib/cn'

interface AppShellProps {
  /** Left navigation column. */
  sidebar: ReactNode
  /** Right-hand AI copilot column. */
  copilot: ReactNode
  /** Narrows the copilot column to its icon rail width. */
  copilotCollapsed?: boolean
  /** Title shown in the center column's top bar. */
  title: string
  /** Optional per-screen actions rendered in the top bar's drag strip. */
  headerActions?: ReactNode
  /** M28 — the active view OWNS the full center column: no shell padding,
   *  no shell scrolling (the view manages its own scroll areas), and the
   *  column is a height-constrained flex parent so `flex-1` children truly
   *  fill the viewport. Ordinary document-style screens leave this off. */
  fullBleed?: boolean
  /** The active view, rendered in the center column. */
  children: ReactNode
}

/**
 * The three-column desktop layout:
 *   [ sidebar | main view | copilot ]
 * The top strips are draggable so the user can move the OS window.
 */
export default function AppShell({
  sidebar,
  copilot,
  copilotCollapsed = false,
  title,
  headerActions,
  fullBleed = false,
  children
}: AppShellProps): React.JSX.Element {
  const mainScrollRef = useRef<HTMLDivElement>(null)

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-ink">
      {/* Left: navigation */}
      <aside className="w-60 shrink-0 border-r border-line-soft bg-surface">{sidebar}</aside>

      {/* Center: active view */}
      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        {/* Draggable window strip. No visible title here — every screen
            renders its own PageHeader — but `title` still names the screen
            for assistive tech, and `headerActions` gives a screen an escape
            hatch into the drag strip if it ever needs one. */}
        <header
          aria-label={title}
          className="drag flex h-14 shrink-0 items-center justify-end px-6"
        >
          {headerActions && <div className="no-drag flex items-center gap-2">{headerActions}</div>}
        </header>
        {/* BUG-156 — the jump-to-bottom control is a SIBLING of the scroller,
            not a child of it, and that is the whole fix.
            
            An `absolute` element inside an `overflow-y-auto` box is positioned
            against that box's CONTENT, so it scrolls away with it. Measured on
            the running app before this change: the button sat 20px above the
            viewport bottom at scrollTop 0, and 420px above it after scrolling
            400px — it slid up the screen and came to rest on top of whatever
            card happened to be underneath, which is what the founder reported
            ("only stays in the page in one spot at all pages").
            
            This wrapper is positioned and does NOT scroll, so `bottom-5` now
            means "above the bottom edge of the visible column" — the same
            anchoring every other app gives this affordance. The scroller keeps
            its own `relative` because page content still positions against it.
            
            The ref stays on the element that actually scrolls; ScrollToEnd
            measures through it and never needed to be inside it. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={mainScrollRef}
            className={cn(
              'relative',
              fullBleed
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden'
                : 'flex-1 overflow-y-auto px-8 py-7'
            )}
          >
            {children}
          </div>
          {/* Not on full-bleed screens: there the scroller is a child, so
              this element never scrolls and the button would never show —
              worse, it would look like the feature is missing. */}
          {!fullBleed && <ScrollToEnd targetRef={mainScrollRef} />}
        </div>
      </main>

      {/* Right: AI copilot — width responds to collapsed state so the whole
          column (border included) narrows, not just its inner content. */}
      <aside
        className={cn(
          'shrink-0 overflow-hidden border-l border-line-soft bg-surface transition-[width] duration-200',
          copilotCollapsed ? 'w-16' : 'w-80'
        )}
      >
        {copilot}
      </aside>
    </div>
  )
}
