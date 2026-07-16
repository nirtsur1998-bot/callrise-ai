import type { LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description?: string
  /** Optional primary action rendered below the copy. */
  action?: { label: string; onClick: () => void; icon?: LucideIcon }
  /** Tighter padding for empty states that sit inside a card. */
  compact?: boolean
  /** Render the title as this heading level instead of a plain paragraph —
   *  use 'h2' when this is the ONLY content on a screen (no PageHeader above
   *  it), so the view still has a heading landmark for assistive tech. */
  titleAs?: 'p' | 'h2'
  className?: string
}

/**
 * A consistent, friendly empty state — a soft haloed icon, a headline, a line
 * of guidance, and an optional call to action. Replaces the app's scattered
 * bare "No X yet" text so blank screens feel intentional, not unfinished.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact,
  titleAs = 'p',
  className
}: EmptyStateProps): React.JSX.Element {
  const ActionIcon = action?.icon
  const Title = titleAs
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-10' : 'py-16',
        className
      )}
    >
      {/* Haloed icon: a soft accent disc with a faint outer ring for depth. */}
      <div className="relative mb-4 grid h-14 w-14 place-items-center">
        <span className="absolute inset-0 rounded-2xl bg-accent-soft" />
        <span className="absolute inset-0 rounded-2xl ring-1 ring-accent/15" />
        <Icon className="relative h-6 w-6 text-accent" strokeWidth={1.75} />
      </div>

      <Title className="text-sm font-medium text-ink">{title}</Title>
      {description && (
        <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-muted">{description}</p>
      )}

      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-medium text-white transition hover:brightness-110 active:scale-[0.98]"
        >
          {ActionIcon && <ActionIcon className="h-4 w-4" />}
          {action.label}
        </button>
      )}
    </div>
  )
}
