import { AudioLines, LogOut } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { isMac } from '@renderer/lib/platform'
import { NAV_ITEMS, type NavId } from './nav-items'
import type { AuthUser } from '@renderer/features/auth/types'

interface SidebarProps {
  active: NavId
  onSelect: (id: NavId) => void
  user: AuthUser
  onSignOut: () => void
}

export function Sidebar({ active, onSelect, user, onSignOut }: SidebarProps): React.JSX.Element {
  const displayName = user.name?.trim() || user.email.split('@')[0]
  const initial = (user.name?.trim()?.[0] ?? user.email[0] ?? '?').toUpperCase()
  return (
    <div className="flex h-full flex-col">
      {/* Brand — draggable; padded down on macOS to clear the traffic lights
          (Windows draws its own title bar, so no extra clearance is needed). */}
      <div className={cn('drag flex items-center gap-2.5 px-4 pb-4', isMac ? 'pt-9' : 'pt-4')}>
        <div className="grid h-7 w-7 place-items-center rounded-lg bg-linear-to-br from-accent to-[#9b6cf2] shadow-sm">
          <AudioLines className="h-4 w-4 text-white" strokeWidth={2.25} />
        </div>
        <span className="text-[15px] font-semibold tracking-tight">Sales OS</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-2">
        <ul className="space-y-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const isActive = item.id === active
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  className={cn(
                    'no-drag group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
                    isActive
                      ? 'bg-accent-soft text-ink'
                      : 'text-muted hover:bg-elevated hover:text-ink'
                  )}
                >
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
          })}
        </ul>
      </nav>

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
          <button
            type="button"
            onClick={onSignOut}
            title="Log out"
            className="no-drag grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition hover:bg-elevated hover:text-ink"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
