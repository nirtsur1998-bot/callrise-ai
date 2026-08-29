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
import { isMac } from '@renderer/lib/platform'
import { useRecentlyViewed } from '@renderer/lib/useRecentlyViewed'
import type { RecentKind } from '@renderer/lib/recentlyViewed'
import type { NavId, NavItem } from './nav-items'

export interface PaletteAction {
  id: string
  label: string
  icon: LucideIcon
  onRun: () => void
  /** Display-only shortcut hint (e.g. "⌘⇧L") shown next to the row. Purely
   *  cosmetic here — the caller is responsible for the keydown handler
   *  actually doing the thing; this just teaches the user it exists. Every
   *  action should have one now (M31 Stage 2: this is the actual mechanism
   *  for closing "I only know 50% of my own app's features"), not just the
   *  ones that happened to get one first. */
  shortcut?: string
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  onSelect: (id: NavId) => void
  /** Which screens show up under "Go to" — the caller (MainApp) picks
   *  NAV_ITEMS or NAV_ITEMS_PREVIEW based on the navigationPreview flag. */
  navItems: NavItem[]
  /** M31 Stage 2 — show a "⌘1".."⌘7" hint next to each nav row and actually
   *  register the shortcuts (MainApp owns the keydown handler; this only
   *  controls whether the HINT renders, so a hint is never shown for a key
   *  that doesn't work). Tied to the 7-item preview list, not the legacy
   *  12-item one — a digit-per-row scheme stops being a clean mnemonic past
   *  9 items, so the old nav intentionally doesn't get one. */
  showNumberShortcuts?: boolean
  /** Quick actions shown below the screen-jump results (e.g. "Start a live
   *  call", "Toggle theme"). Optional — the palette works with just nav. */
  actions?: PaletteAction[]
  /** Jump straight to a specific contact/deal/call, not just its screen —
   *  only shown once the user types (searching the whole database on an
   *  empty query would be noise, not a shortcut). Optional so the palette
   *  still works standalone (e.g. in a context with no CRM/calls data). */
  onOpenContact?: (id: string) => void
  onOpenDeal?: (id: string) => void
  onOpenCall?: (id: string) => void
}

interface EntityRow {
  id: string
  label: string
  sublabel?: string
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
  | { kind: 'nav'; id: NavId; label: string; icon: LucideIcon; shortcut?: string }
  | (PaletteAction & { kind: 'action' })
  | { kind: 'recent'; id: string; label: string; icon: LucideIcon; screen: NavId }
  | { kind: 'contact'; id: string; label: string; sublabel?: string }
  | { kind: 'deal'; id: string; label: string; sublabel?: string }
  | { kind: 'call'; id: string; label: string; sublabel?: string }

const ENTITY_ICON = {
  contact: Contact,
  deal: Building2,
  call: PhoneCall
} as const satisfies Record<'contact' | 'deal' | 'call', LucideIcon>

const ENTITY_SECTION_LABEL: Record<'contact' | 'deal' | 'call', string> = {
  contact: 'Contacts',
  deal: 'Deals',
  call: 'Calls'
}

const MAX_ENTITY_RESULTS = 5

function formatCallDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

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
  navItems,
  showNumberShortcuts = false,
  actions = [],
  onOpenContact,
  onOpenDeal,
  onOpenCall
}: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRowRef = useRef<HTMLLIElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)
  const listId = 'command-palette-listbox'

  // Entity data for search-by-name — loaded lazily on first open (not on
  // mount, since the palette can open long before the user ever searches),
  // then cached for the session. A stale list between saves is an acceptable
  // trade for not re-fetching on every keystroke; reopening the palette
  // refreshes it.
  const [contactRows, setContactRows] = useState<EntityRow[]>([])
  const [dealRows, setDealRows] = useState<EntityRow[]>([])
  const [callRows, setCallRows] = useState<EntityRow[]>([])
  useEffect(() => {
    if (!open) return
    let active = true
    if (onOpenContact) {
      void window.api.contacts.list().then((list) => {
        if (active) {
          setContactRows(list.map((c) => ({ id: c.id, label: c.name, sublabel: c.company })))
        }
      })
    }
    if (onOpenDeal) {
      void window.api.deals.list().then((list) => {
        if (active) setDealRows(list.map((d) => ({ id: d.id, label: d.title })))
      })
    }
    if (onOpenCall) {
      void window.api.calls.list().then((list) => {
        if (active) {
          setCallRows(
            list.map((c) => ({ id: c.id, label: c.title, sublabel: formatCallDate(c.createdAt) }))
          )
        }
      })
    }
    return () => {
      active = false
    }
  }, [open, onOpenContact, onOpenDeal, onOpenCall])

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

  const shortcutMod = isMac ? '⌘' : 'Ctrl '
  const navRows: Row[] = useMemo(
    () =>
      navItems.map((i, idx) => ({
        kind: 'nav' as const,
        id: i.id,
        label: i.label,
        icon: i.icon,
        shortcut: showNumberShortcuts && idx < 9 ? `${shortcutMod}${idx + 1}` : undefined
      })),
    [navItems, showNumberShortcuts, shortcutMod]
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

  const { navResults, actionResults, recentResults, contactResults, dealResults, callResults } =
    useMemo(() => {
      const q = query.trim().toLowerCase()
      if (!q) {
        return {
          navResults: navRows,
          actionResults: actionRows,
          recentResults: recentRows,
          contactResults: [] as Row[],
          dealResults: [] as Row[],
          callResults: [] as Row[]
        }
      }
      const matchEntity = (kind: 'contact' | 'deal' | 'call', rows: EntityRow[]): Row[] =>
        rows
          .filter((r) => r.label.toLowerCase().includes(q))
          .slice(0, MAX_ENTITY_RESULTS)
          .map((r) => ({ kind, id: r.id, label: r.label, sublabel: r.sublabel }))
      return {
        navResults: navRows.filter((r) => r.label.toLowerCase().includes(q)),
        actionResults: actionRows.filter((r) => r.label.toLowerCase().includes(q)),
        recentResults: recentRows.filter((r) => r.label.toLowerCase().includes(q)),
        contactResults: matchEntity('contact', contactRows),
        dealResults: matchEntity('deal', dealRows),
        callResults: matchEntity('call', callRows)
      }
    }, [query, navRows, actionRows, recentRows, contactRows, dealRows, callRows])

  const results: Row[] = [
    ...navResults,
    ...actionResults,
    ...contactResults,
    ...dealResults,
    ...callResults,
    ...recentResults
  ]

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
    } else if (row.kind === 'action') {
      row.onRun()
    } else if (row.kind === 'contact') {
      onOpenContact?.(row.id)
    } else if (row.kind === 'deal') {
      onOpenDeal?.(row.id)
    } else {
      onOpenCall?.(row.id)
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
            const Icon =
              row.kind === 'contact' || row.kind === 'deal' || row.kind === 'call'
                ? ENTITY_ICON[row.kind]
                : row.icon
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
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{row.label}</span>
                    {'sublabel' in row && row.sublabel && (
                      <span className="block truncate text-[11px] text-faint">{row.sublabel}</span>
                    )}
                  </span>
                  {'shortcut' in row && row.shortcut && (
                    <kbd className="shrink-0 rounded border border-line bg-canvas px-1.5 py-0.5 text-[10px] font-medium text-faint">
                      {row.shortcut}
                    </kbd>
                  )}
                  {isCurrent && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-faint" />}
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
              {renderSection(
                ENTITY_SECTION_LABEL.contact,
                contactResults,
                navResults.length + actionResults.length
              )}
              {renderSection(
                ENTITY_SECTION_LABEL.deal,
                dealResults,
                navResults.length + actionResults.length + contactResults.length
              )}
              {renderSection(
                ENTITY_SECTION_LABEL.call,
                callResults,
                navResults.length +
                  actionResults.length +
                  contactResults.length +
                  dealResults.length
              )}
              {renderSection(
                'Recent',
                recentResults,
                navResults.length +
                  actionResults.length +
                  contactResults.length +
                  dealResults.length +
                  callResults.length
              )}
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
