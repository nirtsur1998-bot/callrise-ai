import { Home, type LucideIcon } from 'lucide-react'
import { EmptyState } from './EmptyState'
import type { NavId } from '@renderer/features/navigation/nav-items'

interface PlaceholderViewProps {
  title: string
  icon: LucideIcon
  /** Lets the empty state offer an escape hatch back to Home. */
  onNavigate: (id: NavId) => void
}

/** Empty-state shown for sidebar sections we haven't built yet. */
export function PlaceholderView({
  title,
  icon: Icon,
  onNavigate
}: PlaceholderViewProps): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState
        icon={Icon}
        title={title}
        titleAs="h2"
        description="This section is part of the CallRise AI vision — we’ll build it in a later step."
        action={{ label: 'Back to Home', onClick: () => onNavigate('home'), icon: Home }}
      />
    </div>
  )
}
