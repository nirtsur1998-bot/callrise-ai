import type { ReactNode } from 'react'
import { cn } from '@renderer/lib/cn'

interface CardProps {
  className?: string
  children: ReactNode
}

/** A soft, rounded surface used throughout the app. The whisper-soft
 *  `shadow-card` lifts it off the canvas so the UI reads as layered depth
 *  rather than flat outlined boxes. */
export function Card({ className, children }: CardProps): React.JSX.Element {
  return (
    <div
      className={cn('rounded-2xl border border-line-soft bg-surface p-5 shadow-card', className)}
    >
      {children}
    </div>
  )
}
