// Tiny, hand-rolled bars — no chart dependency. They reuse the coaching Tone
// colors so a value's health reads at a glance (green marker = healthy).

import { cn } from '@renderer/lib/cn'
import { type Tone, TONE_BAR } from '@renderer/features/coaching/meta'
import type { PeriodBucket } from './aggregate'

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, n))
}

function positionPct(value: number, min: number, max: number): number {
  if (max <= min) return 0
  return clampPct(((value - min) / (max - min)) * 100)
}

/**
 * A value on a scale, with the healthy zone shaded and a tone-colored marker
 * showing where the value sits. Used for skills (1–5) and talk ratio (0–1).
 */
export function MeterBar({
  value,
  min,
  max,
  healthyFrom,
  healthyTo,
  tone
}: {
  value: number
  min: number
  max: number
  healthyFrom?: number
  healthyTo?: number
  tone: Tone
}): React.JSX.Element {
  const marker = positionPct(value, min, max)
  const showBand = healthyFrom !== undefined && healthyTo !== undefined
  const bandLeft = showBand ? positionPct(healthyFrom, min, max) : 0
  const bandRight = showBand ? positionPct(healthyTo, min, max) : 0

  return (
    <div className="relative h-2 w-full rounded-full bg-line">
      {showBand && (
        <div
          className="absolute inset-y-0 rounded-full bg-emerald-500/20"
          style={{ left: `${bandLeft}%`, width: `${Math.max(0, bandRight - bandLeft)}%` }}
        />
      )}
      <div
        className={cn(
          'absolute top-1/2 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface',
          TONE_BAR[tone]
        )}
        style={{ left: `${marker}%` }}
      />
    </div>
  )
}

/** A simple progress fill (0–1), colored by tone. Used for task completion. */
export function ProgressBar({ value, tone }: { value: number; tone: Tone }): React.JSX.Element {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-line">
      <div
        className={cn('h-full rounded-full transition-[width]', TONE_BAR[tone])}
        style={{ width: `${clampPct(value * 100)}%` }}
      />
    </div>
  )
}

/** Small neutral bars for calls-per-period. Volume isn't graded, so no tone. */
export function ActivityBars({ buckets }: { buckets: PeriodBucket[] }): React.JSX.Element {
  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0) || 1
  return (
    <div className="flex h-16 items-end gap-1.5">
      {buckets.map((b) => (
        <div
          key={b.key}
          className="flex-1 rounded-t bg-accent/70"
          style={{ height: `${Math.max((b.count / max) * 100, b.count > 0 ? 6 : 2)}%` }}
          title={`${b.label}: ${b.count} call${b.count === 1 ? '' : 's'}`}
        />
      ))}
    </div>
  )
}
