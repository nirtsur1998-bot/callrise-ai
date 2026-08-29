import { AudioLines, Building2, Contact, LogOut, PhoneCall, Search } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { isMac } from '@renderer/lib/platform'
import { IconButton } from '@renderer/components/IconButton'
import { useRecentlyViewed } from '@renderer/lib/useRecentlyViewed'
import type { RecentKind } from '@renderer/lib/recentlyViewed'
import type { NavId, NavItem } from './nav-items'
import type { AuthUser } from '@renderer/features/auth/types'

/** Number of "recently viewed" rows shown in the sidebar trail. */
const MAX_RECENT_ROWS = 5

/** Icon per recent-item kind — matches the icon already established for
 *  that kind elsewhere in the app (Live Calls' PhoneCall, the CRM nav
 *  item's Contact, and Building2 used throughout the deals feature). */
const RECENT_KIND_ICON = {
  call: PhoneCall,
  contact: Contact,
  deal: Building2
} as const satisfies Record<RecentKind, typeof PhoneCall>

/** The screen a recent item's kind lives on. `onSelect` only takes a
 *  screen-level NavId, so clicking a recent contact/deal opens the CRM
 *  screen (not the specific record — see Sidebar's recent-section comment
 *  for why). */
const RECENT_KIND_SCREEN: Record<RecentKind, NavId> = {
  call: 'past-calls',
  contact: 'crm',
  deal: 'crm'
}

interface SidebarProps {
  active: NavId
  onSelect: (id: NavId) => void
  user: AuthUser
  onSignOut: () => void
  /** Opens the command palette (also bound to ⌘K globally). */
  onOpenPalette: () => void
  /** M31 Stage 2 — the caller (MainApp) picks NAV_ITEMS or NAV_ITEMS_PREVIEW
   *  based on the navigationPreview flag; Sidebar just renders whichever
   *  list it's given. `onSelect` still takes any NavId, including the old
   *  ones (`past-calls`, `crm`, ...) the recent-trail always emits — the
   *  caller is responsible for remapping those to a hub id when the preview
   *  is on, so this component never needs to know the flag exists. */
  navItems: NavItem[]
}

export function Sidebar({
  active,
  onSelect,
  user,
  onSignOut,
  onOpenPalette,
  navItems
}: SidebarProps): React.JSX.Element {
  const displayName = user.name?.trim() || user.email.split('@')[0]
  const initial = (user.name?.trim()?.[0] ?? user.email[0] ?? '?').toUpperCase()

  const recentItems = useRecentlyViewed().slice(0, MAX_RECENT_ROWS)

  // Settings is pinned above the footer, not part of the scrolling list.
  const settingsItem = navItems.find((item) => item.id === 'settings')
  const scrollItems = navItems.filter((item) => item.id !== 'settings')

  // Group the scrolling items by their `section`, preserving list order —
  // items sharing a section render as one contiguous group.
  const groups: { section: string | undefined; items: typeof scrollItems }[] = []
  for (const item of scrollItems) {
    const last = groups[groups.length - 1]
    if (last && last.section === item.section) {
      last.items.push(item)
    } else {
      groups.push({ section: item.section, items: [item] })
    }
  }

  const renderNavButton = (item: (typeof scrollItems)[number]): React.JSX.Element => {
    const Icon = item.icon
    const isActive = item.id === active
    return (
      <li key={item.id}>
        <button
          type="button"
          onClick={() => onSelect(item.id)}
          aria-current={isActive ? 'page' : undefined}
          className={cn(
            'no-drag group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
            isActive ? 'bg-accent-soft text-ink' : 'text-muted hover:bg-elevated hover:text-ink'
          )}
        >
          {/* Signature left indicator, flush to the sidebar edge. Always
              mounted so it can transition in/out instead of popping. */}
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-1/2 left-0 h-5 w-[3px] -translate-x-3 -translate-y-1/2 origin-center rounded-r-full bg-accent transition-transform duration-200',
              isActive ? 'scale-y-100' : 'scale-y-0'
            )}
          />
          <Icon
            className={cn(
              'h-[18px] w-[18px] transition-colors',
              isActive ? 'text-accent' : 'text-faint group-hover:text-muted'
            )}
            strokeWidth={2}
          />
          <span className="font-medium">{item.label}</span>
        </button>
      </li>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Brand — draggable; padded down on macOS to clear the traffic lights
          (Windows draws its own title bar, so no extra clearance is needed). */}
      <div className={cn('drag flex items-center gap-2.5 px-4 pb-3', isMac ? 'pt-9' : 'pt-4')}>
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-brand shadow-sm">
          <AudioLines className="h-4 w-4 text-white" strokeWidth={2.25} />
        </div>
        <span className="text-[15px] font-semibold tracking-tight">CallRise AI</span>
      </div>

      {/* Quick search / command palette trigger */}
      <div className="px-3 pb-1">
        <button
          type="button"
          onClick={onOpenPalette}
          className="no-drag flex w-full items-center gap-2.5 rounded-lg border border-line-soft bg-canvas px-3 py-2 text-[13px] text-faint transition hover:border-line hover:text-muted"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">Jump to…</span>
          <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-faint">
            {isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        </button>
      </div>

      {/* Navigation */}
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="space-y-4">
          {groups.map((group, i) => (
            <li key={group.section ?? `group-${i}`}>
              {group.section && (
                <p className="mb-1.5 px-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
                  {group.section}
                </p>
              )}
              <ul className="space-y-0.5">{group.items.map(renderNavButton)}</ul>
            </li>
          ))}

          {/* Recent — a trail of the last few calls/contacts/deals opened
              elsewhere in the app (lib/recentlyViewed.ts).
              Only rendered once something's been visited. `onSelect` is
              screen-level only, so a recent contact/deal opens the CRM
              screen (defaulting to its Contacts tab) rather than the exact
              record — true deep-linking would need CrmView/MainApp to
              accept an initial record id from the sidebar, which is outside
              this component's scope. */}
          {recentItems.length > 0 && (
            <li>
              <p className="mb-1.5 px-2 text-[11px] font-semibold tracking-wide text-faint uppercase">
                Recent
              </p>
              <ul className="space-y-0.5">
                {recentItems.map((item) => {
                  const Icon = RECENT_KIND_ICON[item.kind]
                  return (
                    <li key={`${item.kind}-${item.id}`}>
                      <button
                        type="button"
                        onClick={() => onSelect(RECENT_KIND_SCREEN[item.kind])}
                        title={item.label}
                        className="press no-drag flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[12px] text-muted transition-colors hover:bg-elevated hover:text-ink"
                      >
                        <Icon className="h-3.5 w-3.5 shrink-0 text-faint" strokeWidth={2} />
                        <span className="truncate">{item.label}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </li>
          )}
        </ul>
      </nav>

      {/* Settings — pinned above the footer, not part of the scrolling list. */}
      {settingsItem && (
        <div className="border-t border-line-soft px-3 py-2">
          <ul>{renderNavButton(settingsItem)}</ul>
        </div>
      )}

      {/* Footer — signed-in user + log out. */}
      <div className="border-t border-line-soft px-3 py-3">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{displayName}</p>
            <p className="truncate text-[11px] text-faint">{user.email}</p>
          </div>
          <IconButton
            icon={LogOut}
            label="Log out"
            onClick={onSignOut}
            className="no-drag shrink-0"
          />
        </div>
      </div>
    </div>
  )
}
