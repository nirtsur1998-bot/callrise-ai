import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

interface CardProps {
  className?: string
  children: ReactNode
}

/** A soft, rounded surface used throughout the app. */
export function Card({ className, children }: CardProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-2xl border border-line-soft bg-surface p-5',
        className
      )}
    >
      {children}
    </div>
  )
}
