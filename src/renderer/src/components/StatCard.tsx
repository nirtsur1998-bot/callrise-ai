import type { LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

interface StatCardProps {
  icon: LucideIcon
  label: string
  value: string
  /** Text color class for the value (e.g. a semantic token like 'text-positive'). */
  tone?: string
  className?: string
}

/** A small labeled stat tile — "Calls · 4", "Last contact · 2d ago", "Avg.
 *  coach score · 87" — reused across Home and every detail screen so figures
 *  line up (tabular-nums) and share one card shape. */
export function StatCard({
  icon: Icon,
  label,
  value,
  tone = 'text-ink',
  className
}: StatCardProps): React.JSX.Element {
  return (
    <div className={cn('rounded-xl border border-line-soft bg-surface px-4 py-3', className)}>
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
        <Icon className="h-3 w-3" /> {label}
      </p>
      <p className={cn('mt-1 text-lg font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  )
}
