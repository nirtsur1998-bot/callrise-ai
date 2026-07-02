import { AudioLines } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { NAV_ITEMS, type NavId } from './nav-items'

interface SidebarProps {
  active: NavId
  onSelect: (id: NavId) => void
}

export function Sidebar({ active, onSelect }: SidebarProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      {/* Brand — draggable, padded down to clear the macOS traffic lights. */}
      <div className="drag flex items-center gap-2.5 px-4 pt-9 pb-4">
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

      {/* Footer — workspace placeholder. */}
      <div className="border-t border-line-soft px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-full bg-elevated text-[11px] font-semibold text-muted">
            N
          </div>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium">Your workspace</p>
            <p className="truncate text-[11px] text-faint">v0.1.0 · dev</p>
          </div>
        </div>
      </div>
    </div>
  )
}
