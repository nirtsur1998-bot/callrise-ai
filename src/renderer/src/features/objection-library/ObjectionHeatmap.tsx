import { useMemo } from 'react'
import { useObjectionQueue } from './useObjectionQueue'
import { TYPE_LABEL, type MinedObjectionType } from './types'

// Below this many total entries, a ranked bar list reads as broken (one
// lonely bar at 100%) rather than informative — same "early days" threshold
// analytics/verdicts.ts (THIN_DATA) uses for its own thin-data caveats.
const MIN_ENTRIES_FOR_CHART = 3

interface TypeCount {
  type: MinedObjectionType
  label: string
  count: number
}

/** Deterministic count-per-type, sorted most-frequent first. Ties keep
 *  TYPE_LABEL's declared order (stable sort) so re-renders don't jitter. */
function countByType(types: MinedObjectionType[]): TypeCount[] {
  const counts = new Map<MinedObjectionType, number>()
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1)
  return (Object.keys(TYPE_LABEL) as MinedObjectionType[])
    .map((type) => ({ type, label: TYPE_LABEL[type], count: counts.get(type) ?? 0 }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count)
}

/**
 * "Which objections come up most?" at a glance — a ranked bar list (not a
 * literal heat-grid; matches the hand-rolled-bar convention in
 * analytics/charts.tsx) counting objection TYPES across review-queue
 * candidates.
 *
 * Data source: the review queue only (useObjectionQueue). Approved Knowledge
 * Base scripts (ObjectionEntry) are free-text trigger/response pairs with no
 * `type` field, so they can't be bucketed without guessing — the review
 * queue's mined candidates are the only objection data that already carries
 * a deterministic type, so this is read-only aggregation over data that's
 * realistically available today, no new IPC/storage/AI.
 */
export function ObjectionHeatmap(): React.JSX.Element | null {
  const { items, loading } = useObjectionQueue()

  const rows = useMemo(() => countByType(items.map((i) => i.type)), [items])
  const total = rows.reduce((sum, r) => sum + r.count, 0)

  if (loading) return null

  if (total < MIN_ENTRIES_FOR_CHART) {
    return (
      <p className="text-[13px] text-faint">
        Not enough data yet — early days, based on {total} objection{total === 1 ? '' : 's'}. Mine
        or approve a few more calls to see which types come up most.
      </p>
    )
  }

  const max = rows[0]?.count ?? 1

  return (
    <div className="space-y-2.5">
      {rows.map((row, i) => {
        const widthPct = Math.max((row.count / max) * 100, 6)
        const isTop = i === 0
        return (
          <div key={row.type} className="space-y-1">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className={isTop ? 'font-medium text-ink' : 'text-muted'}>{row.label}</span>
              <span
                className={
                  isTop ? 'font-medium tabular-nums text-accent' : 'tabular-nums text-faint'
                }
              >
                {row.count}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-line">
              <div
                className={isTop ? 'h-2 rounded-full bg-accent' : 'h-2 rounded-full bg-faint'}
                style={{ width: `${widthPct}%` }}
              />
            </div>
          </div>
        )
      })}
      <p className="pt-1 text-[11px] text-faint">
        Based on {total} pending review-queue candidate{total === 1 ? '' : 's'}.
      </p>
    </div>
  )
}
