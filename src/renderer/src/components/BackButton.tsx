import { ArrowLeft } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

interface BackButtonProps {
  onClick: () => void
  label: string
  className?: string
}

/** The "← Past Calls" / "← Deals" / "← Contacts" pattern every detail screen
 *  opens with — one place owning the arrow + hover treatment. */
export function BackButton({ onClick, label, className }: BackButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'press flex items-center gap-2 text-sm text-muted transition hover:text-ink',
        className
      )}
    >
      <ArrowLeft className="h-4 w-4" /> {label}
    </button>
  )
}
