import type { LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { Tooltip } from './Tooltip'

interface IconButtonProps {
  icon: LucideIcon
  onClick?: () => void
  /** Accessible name — required, since the button shows only an icon. */
  label: string
  disabled?: boolean
  /** 'ghost' (default) for toolbar/refresh actions, 'danger' for destructive. */
  variant?: 'ghost' | 'danger'
  className?: string
}

/** The app's most copy-pasted control — a square icon-only button (refresh,
 *  edit, delete, close). One primitive so toolbars, dialog footers, and row
 *  actions stay identical, with a real accessible label + press feedback. */
export function IconButton({
  icon: Icon,
  onClick,
  label,
  disabled,
  variant = 'ghost',
  className
}: IconButtonProps): React.JSX.Element {
  // M35 — the label is spoken by aria-label and SHOWN by the Tooltip primitive
  // (hover and focus, themed, delayed) instead of a native `title`. One change
  // here converts every icon-only control in the app — 68 sites at the time.
  return (
    <Tooltip content={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-faint transition disabled:opacity-40',
          variant === 'danger'
            ? 'hover:bg-danger-soft hover:text-danger'
            : 'hover:bg-elevated hover:text-ink',
          className
        )}
      >
        <Icon className="h-4 w-4" />
      </button>
    </Tooltip>
  )
}
