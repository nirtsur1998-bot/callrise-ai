import type { ReactNode } from 'react'
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
  children
}: AppShellProps): React.JSX.Element {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-ink">
      {/* Left: navigation */}
      <aside className="w-60 shrink-0 border-r border-line-soft bg-surface">{sidebar}</aside>

      {/* Center: active view */}
      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        <header className="drag flex h-14 shrink-0 items-center border-b border-line-soft px-6">
          <h1 className="text-sm font-medium text-muted">{title}</h1>
        </header>
        <div className="flex-1 overflow-y-auto px-8 py-7">{children}</div>
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
