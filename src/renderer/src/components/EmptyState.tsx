import type { LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { openSettingsAt } from '@renderer/features/settings/settingsNav'
import {
  REASON_BADGE,
  resolveEmptyStateAction,
  type EmptyStateAction,
  type EmptyStateReason
} from './emptyStatePolicy'

export type { EmptyStateReason } from './emptyStatePolicy'

/**
 * A consistent, friendly empty state — a soft haloed icon, a headline, a line
 * of guidance, and an optional call to action.
 *
 * M31 Stage 3 gave it the tri-state standard: an empty screen now says WHICH
 * kind of empty it is, because "nothing here yet", "switched off" and "needs
 * a key" point at three different user actions and used to look identical.
 * The rules live in emptyStatePolicy.ts (and are tested there); this file is
 * presentation only.
 */

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  /** One line on what this screen holds. For an `off` state the "what it
   *  does" sentence lives on the reason instead (see `what`), because that
   *  one is REQUIRED and this one is not. */
  description?: string
  /** Optional primary action rendered below the copy. */
  action?: EmptyStateAction
  /** Which of the four states this is. Defaults to plain `empty`. */
  reason?: EmptyStateReason
  /** Tighter padding for empty states that sit inside a card. */
  compact?: boolean
  /** Render the title as this heading level instead of a plain paragraph —
   *  use 'h2' when this is the ONLY content on a screen (no PageHeader above
   *  it), so the view still has a heading landmark for assistive tech. */
  titleAs?: 'p' | 'h2'
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  reason = { kind: 'empty' },
  compact,
  titleAs = 'p',
  className
}: EmptyStateProps): React.JSX.Element {
  const Title = titleAs
  const badge = REASON_BADGE[reason.kind]
  const BadgeIcon = badge.icon

  const primary = resolveEmptyStateAction(reason, action, openSettingsAt)
  const PrimaryIcon = primary?.icon ?? (() => null)

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

      {/* The state label, above the title. Deliberately a separate line rather
          than folded into the copy: it is the part that has to be scannable
          without reading, because the whole complaint was that these all
          looked the same at a glance. */}
      {BadgeIcon && (
        <p
          className={cn(
            'mb-1.5 inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide uppercase',
            badge.tone
          )}
        >
          <BadgeIcon className="h-3 w-3" aria-hidden />
          {badge.label}
        </p>
      )}

      <Title className="text-sm font-medium text-ink">{title}</Title>
      {/* An off-state's "what it does" line is REQUIRED and comes from the
          reason; everything else uses the optional description. Rendered in
          the same slot so the two never stack into a wall of text. */}
      {reason.kind === 'off' ? (
        <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-muted">{reason.what}</p>
      ) : (
        description && (
          <p className="mt-1.5 max-w-xs text-[13px] leading-relaxed text-muted">{description}</p>
        )
      )}

      {reason.kind === 'off' && reason.cost && (
        <p className="mt-1.5 max-w-xs text-[12px] leading-relaxed text-faint">{reason.cost}</p>
      )}
      {reason.kind === 'broken' && (
        <p className="mt-1.5 max-w-xs text-[12px] leading-relaxed text-danger">{reason.detail}</p>
      )}

      {primary && (
        <button
          type="button"
          onClick={primary.onClick}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-accent-fill px-3.5 py-2 text-[13px] font-medium text-on-accent transition hover:brightness-110 active:scale-[0.98]"
        >
          <PrimaryIcon className="h-4 w-4" />
          {primary.label}
        </button>
      )}
    </div>
  )
}
