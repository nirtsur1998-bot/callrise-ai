import { cn } from '@renderer/lib/cn'

/** A single shimmering placeholder block. Compose these to mirror the real
 *  layout of whatever is loading, instead of a bare centered "Loading…". */
export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <div className={cn('animate-shimmer rounded-md', className)} aria-hidden="true" />
}

/** A stack of N list-row skeletons matching the app's standard card-row shape
 *  (`rounded-xl border bg-surface px-4 py-3.5`). Used by list screens. */
export function SkeletonRows({ rows = 5 }: { rows?: number }): React.JSX.Element {
  return (
    <ul className="space-y-2.5" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3.5 shadow-card"
        >
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-4 w-12" />
        </li>
      ))}
    </ul>
  )
}
