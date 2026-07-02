import type { LucideIcon } from 'lucide-react'

interface PlaceholderViewProps {
  title: string
  icon: LucideIcon
}

/** Empty-state shown for sidebar sections we haven't built yet. */
export function PlaceholderView({
  title,
  icon: Icon
}: PlaceholderViewProps): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-line-soft bg-surface">
        <Icon className="h-6 w-6 text-faint" strokeWidth={1.75} />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-1.5 max-w-xs text-sm text-muted">
        This section is part of the Sales OS vision. We&rsquo;ll build it in a
        later step.
      </p>
    </div>
  )
}
