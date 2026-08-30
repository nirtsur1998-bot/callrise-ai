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
        {/* `relative` so ScrollToEnd can anchor to this column, and the ref
            so it can measure it. Attached HERE rather than per page: every
            ordinary screen scrolls inside this one element, so a new long
            page inherits the control without knowing it exists. Full-bleed
            screens own their own scroller and attach their own (CallDetail
            does). */}
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
