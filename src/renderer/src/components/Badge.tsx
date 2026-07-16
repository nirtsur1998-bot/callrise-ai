import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

export type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger' | 'accent'

const TONE: Record<BadgeTone, string> = {
  neutral: 'border-line-soft bg-canvas text-muted',
  positive: 'border-positive/30 bg-positive-soft text-positive',
  warning: 'border-warning/30 bg-warning-soft text-warning',
  danger: 'border-danger/30 bg-danger-soft text-danger',
  accent: 'border-accent/30 bg-accent-soft text-accent'
}

interface BadgeProps {
  children: ReactNode
  tone?: BadgeTone
  icon?: LucideIcon
  title?: string
  className?: string
}

/**
 * One rounded-full status pill — replaces the ~6 copy-pasted badge markups
 * (StaleBadge, task priority, deal stage/risk, contact recency, objection
 * type). Every tone routes through the semantic status tokens, so badges are
 * theme-correct and consistent. Always icon-optional + text, never color-only.
 */
export function Badge({
  children,
  tone = 'neutral',
  icon: Icon,
  title,
  className
}: BadgeProps): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        TONE[tone],
        className
      )}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  )
}
