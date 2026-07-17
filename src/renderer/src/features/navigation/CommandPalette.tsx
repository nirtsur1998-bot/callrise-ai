import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Search,
  CornerDownLeft,
  PhoneCall,
  Contact,
  Building2,
  type LucideIcon
} from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { useRecentlyViewed } from '@renderer/lib/useRecentlyViewed'
import type { RecentKind } from '@renderer/lib/recentlyViewed'
import { NAV_ITEMS, type NavId } from './nav-items'

export interface PaletteAction {
  id: string
  label: string
  icon: LucideIcon
  onRun: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onSelect: (id: NavId) => void
  /** Quick actions shown below the screen-jump results (e.g. "Start a live
   *  call", "Toggle theme"). Optional — the palette works with just nav. */
  actions?: PaletteAction[]
}

/** Icon per recent-item kind — matches the icon already established for that
 *  kind in the Sidebar's own "Recent" trail (Live Calls' PhoneCall, the CRM
 *  nav item's Contact, and Building2 used throughout the deals feature). */
const RECENT_KIND_ICON = {
  call: PhoneCall,
  contact: Contact,
  deal: Building2
} as const satisfies Record<RecentKind, LucideIcon>

/** The screen a recent item's kind lives on. `onSelect` only takes a
 *  screen-level NavId, so — same limitation as the Sidebar's recent
 *  section — selecting a recent contact/deal opens the CRM screen (not the
 *  specific record); true deep-linking would need MainApp to accept an
 *  initial record id, which is outside this component's scope. */
const RECENT_KIND_SCREEN: Record<RecentKind, NavId> = {
  call: 'past-calls',
  contact: 'crm',
  deal: 'crm'
}

type Row =
  | { kind: 'nav'; id: NavId; label: string; icon: LucideIcon }
  | (PaletteAction & { kind: 'action' })
  | { kind: 'recent'; id: string; label: string; icon: LucideIcon; screen: NavId }

/**
 * A ⌘K command palette for jumping to any screen — the Linear/Raycast/Arc
 * quick-nav pattern. Substring-filtered, fully keyboard-driven (↑/↓ to move,
 * ↵ to open, Esc to close). Built to grow: today it holds navigation plus a
 * handful of quick actions.
 */
export function CommandPalette({
  open,
  onClose,
  onSelect,
  actions = []
}: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRowRef = useRef<HTMLLIElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const listId = 'command-palette-listbox'

  // Reset each time it opens, and focus the input; restore focus to whatever
  // triggered the palette when it closes.
  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberately reset the query/cursor when the palette opens
      setQuery('')
      setCursor(0)
      // Focus after paint so the autofocus lands reliably.
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      previouslyFocused.current?.focus?.()
    }
  }, [open])

  const navRows: Row[] = useMemo(
    () => NAV_ITEMS.map((i) => ({ kind: 'nav' as const, id: i.id, label: i.label, icon: i.icon })),
    []
  )
  const actionRows: Row[] = useMemo(
    () => actions.map((a) => ({ kind: 'action' as const, ...a })),
    [actions]
  )
  const recentlyViewed = useRecentlyViewed()
  const recentRows: Row[] = useMemo(
    () =>
      recentlyViewed.map((item) => ({
        kind: 'recent' as const,
        id: `${item.kind}-${item.id}`,
        label: item.label,
        icon: RECENT_KIND_ICON[item.kind],
        screen: RECENT_KIND_SCREEN[item.kind]
      })),
    [recentlyViewed]
  )

  const { navResults, actionResults, recentResults } = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return { navResults: navRows, actionResults: actionRows, recentResults: recentRows }
    return {
      navResults: navRows.filter((r) => r.label.toLowerCase().includes(q)),
      actionResults: actionRows.filter((r) => r.label.toLowerCase().includes(q)),
      recentResults: recentRows.filter((r) => r.label.toLowerCase().includes(q))
    }
  }, [query, navRows, actionRows, recentRows])

  const results: Row[] = [...navResults, ...actionResults, ...recentResults]

  // Clamp the highlighted row during render, so a filter that shrinks the
  // list never leaves the cursor out of range.
  const cur = results.length ? Math.min(cursor, results.length - 1) : 0
  const currentRow = results[cur]
  const activeId = currentRow
    ? `command-palette-option-${currentRow.kind}-${currentRow.id}`
    : undefined

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cur])

  if (!open) return null

  const run = (row: Row): void => {
    if (row.kind === 'nav') {
      onSelect(row.id)
    } else if (row.kind === 'recent') {
      onSelect(row.screen)
    } else {
      row.onRun()
    }
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(Math.min(cur + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(Math.max(cur - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = results[cur]
      if (row) run(row)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  const renderSection = (label: string, rows: Row[], offset: number): ReactNode => {
    if (rows.length === 0) return null
    return (
      <div className="mb-1 last:mb-0">
        <p className="px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">
          {label}
        </p>
        <ul>
          {rows.map((row, i) => {
            const idx = offset + i
            const isCurrent = idx === cur
            const rowId = `command-palette-option-${row.kind}-${row.id}`
            const Icon = row.icon
            return (
              <li key={rowId} ref={isCurrent ? activeRowRef : undefined}>
                <button
                  type="button"
                  id={rowId}
                  role="option"
                  aria-selected={isCurrent}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => run(row)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                    isCurrent ? 'bg-accent-soft text-ink' : 'text-muted'
                  )}
                >
                  <Icon
                    className={cn('h-[18px] w-[18px]', isCurrent ? 'text-accent' : 'text-faint')}
                    strokeWidth={2}
                  />
                  <span className="flex-1 font-medium">{row.label}</span>
                  {isCurrent && <CornerDownLeft className="h-3.5 w-3.5 text-faint" />}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[16vh]"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      {/* Scrim */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />

      {/* Palette */}
      <div
        className="animate-pop relative flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {/* Search field */}
        <div className="flex items-center gap-3 border-b border-line-soft px-4">
          <Search className="h-4 w-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to…"
            role="combobox"
            aria-expanded={true}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-label="Jump to a screen"
            className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
          />
          <kbd className="rounded border border-line bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-faint">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div
          id={listId}
          role="listbox"
          aria-label="Screens and actions"
          className="max-h-[52vh] overflow-y-auto p-2"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-faint">No matches</p>
          ) : (
            <>
              {renderSection('Go to', navResults, 0)}
              {renderSection('Actions', actionResults, navResults.length)}
              {renderSection('Recent', recentResults, navResults.length + actionResults.length)}
            </>
          )}
        </div>

        {/* Footer legend */}
        <div className="border-t border-line-soft px-4 py-2 text-[11px] text-faint">
          ↑↓ Navigate · ↵ Open · Esc Close
        </div>
      </div>
    </div>
  )
}
