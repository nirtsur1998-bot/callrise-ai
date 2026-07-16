import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'danger'
export type ButtonSize = 'sm' | 'md'

interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'className' | 'children'
> {
  /** 'primary' (default, solid accent CTA) | 'secondary' (bordered/ghost) | 'danger' (destructive, WITH visible text — for icon-only destructive actions use IconButton instead). */
  variant?: ButtonVariant
  /** 'md' (default) for standalone screen actions, 'sm' for compact/dialog-footer/inline contexts. */
  size?: ButtonSize
  icon?: LucideIcon
  /** Where the icon sits relative to the label. Defaults to 'left'. */
  iconPosition?: 'left' | 'right'
  fullWidth?: boolean
  className?: string
  children: ReactNode
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white font-medium hover:brightness-110',
  secondary: 'border border-line text-muted font-medium hover:bg-elevated hover:text-ink',
  danger: 'bg-danger-soft text-danger font-semibold hover:bg-danger/20'
}

const SIZE: Record<ButtonSize, { pad: string; text: string; gap: string; icon: string }> = {
  md: { pad: 'px-3.5 py-2', text: 'text-sm', gap: 'gap-2', icon: 'h-4 w-4' },
  sm: { pad: 'px-2.5 py-1.5', text: 'text-xs', gap: 'gap-1.5', icon: 'h-3.5 w-3.5' }
}

/**
 * The app's shared CTA/secondary/destructive button — one place owning the
 * accent-solid, bordered-ghost, and danger-soft treatments (plus size, icon
 * placement, and press feedback) instead of each screen re-typing the same
 * className string with small drifts.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'left',
  fullWidth,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps): React.JSX.Element {
  const s = SIZE[size]
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'press inline-flex shrink-0 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-50',
        s.pad,
        s.text,
        s.gap,
        VARIANT[variant],
        fullWidth && 'w-full',
        className
      )}
      {...rest}
    >
      {Icon && iconPosition === 'left' && <Icon className={s.icon} />}
      {children}
      {Icon && iconPosition === 'right' && <Icon className={s.icon} />}
    </button>
  )
}
