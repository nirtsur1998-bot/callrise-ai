import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

interface PageHeaderProps {
  title: ReactNode
  /** A count shown next to the title (rendered as faint tabular figures). */
  count?: ReactNode
  subtitle?: ReactNode
  /** Right-aligned actions (buttons, filters, toggles). */
  actions?: ReactNode
  className?: string
}

/**
 * The canonical screen header — one title rhythm across every list/detail
 * screen, so headers stop drifting in size, count treatment, and spacing.
 * Owns the tabular count slot so all data figures line up.
 */
export function PageHeader({
  title,
  count,
  subtitle,
  actions,
  className
}: PageHeaderProps): React.JSX.Element {
  return (
    <header className={cn('mb-5 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-lg font-semibold tracking-tight text-ink">{title}</h2>
          {count !== undefined && count !== null && (
            <span className="text-[13px] text-faint tabular-nums">{count}</span>
          )}
        </div>
        {subtitle && <p className="mt-1 text-[13px] text-faint">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  )
}
