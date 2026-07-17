// Tiny, hand-rolled bars — no chart dependency. They reuse the coaching Tone
// colors so a value's health reads at a glance (green marker = healthy).

import { useEffect, useState } from 'react'
import { cn } from '@renderer/lib/cn'
import { type Tone, TONE_BAR } from '@renderer/features/coaching/meta'
import type { PeriodBucket, PipelineForecastBucket } from './aggregate'

/** Short "$48K"-style currency, for labels too small for full formatting.
 *  Not exported — react-refresh requires component files to only export
 *  components, so `AnalyticsView.tsx` keeps its own copy for the verdict. */
function formatCompactCurrency(value: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(value)
}

/** Animates a 0..1 progress value from 0 to `target` on mount, via
 *  requestAnimationFrame — a subtle "filling in" entrance instead of the bar
 *  just appearing at full size. */
function useMountProgress(target: number): number {
  const [value, setValue] = useState(0)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setValue(target))
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- animate to the mount-time target once, not on every value change
  }, [])
  return value
}

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
  tone,
  showEndpointLabels
}: {
  value: number
  min: number
  max: number
  healthyFrom?: number
  healthyTo?: number
  tone: Tone
  /** Show min/max numeric labels under the bar's endpoints. */
  showEndpointLabels?: boolean
}): React.JSX.Element {
  const marker = positionPct(value, min, max)
  const showBand = healthyFrom !== undefined && healthyTo !== undefined
  const bandLeft = showBand ? positionPct(healthyFrom, min, max) : 0
  const bandRight = showBand ? positionPct(healthyTo, min, max) : 0

  return (
    <div>
      <div
        className="relative h-2 w-full rounded-full bg-line"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
      >
        {showBand && (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 rounded-full bg-positive-soft ring-1 ring-inset ring-positive/25"
            style={{ left: `${bandLeft}%`, width: `${Math.max(0, bandRight - bandLeft)}%` }}
          />
        )}
        <div
          aria-hidden="true"
          className={cn(
            'absolute top-1/2 h-3.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface',
            TONE_BAR[tone]
          )}
          style={{ left: `${marker}%` }}
        />
      </div>
      {showEndpointLabels && (
        <div className="mt-1 flex justify-between text-[11px] text-faint">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      )}
    </div>
  )
}

/** A simple progress fill (0–1), colored by tone. Used for task completion.
 *  Marks the 70% "good" threshold (matching `completionTone`) and animates
 *  in from 0 on mount. */
export function ProgressBar({ value, tone }: { value: number; tone: Tone }): React.JSX.Element {
  const animated = useMountProgress(value)
  return (
    <div
      className="relative h-2 w-full overflow-hidden rounded-full bg-line"
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', TONE_BAR[tone])}
        style={{ width: `${clampPct(animated * 100)}%` }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-y-0 w-px bg-surface/60"
        style={{ left: '70%' }}
      />
    </div>
  )
}

/** Small neutral bars for calls-per-period. Volume isn't graded, so no tone.
 *  Zero-activity columns get a faint full-height track so they read as
 *  visibly-empty rather than invisible, and bars animate in on mount. */
export function ActivityBars({ buckets }: { buckets: PeriodBucket[] }): React.JSX.Element {
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const max = buckets.reduce((m, b) => Math.max(m, b.count), 0) || 1
  const total = buckets.reduce((sum, b) => sum + b.count, 0)
  const summary =
    buckets.length === 0
      ? 'No activity data'
      : `Calls per period: ${total} total across ${buckets.length} period${buckets.length === 1 ? '' : 's'}, from ${buckets[0].label} to ${buckets[buckets.length - 1].label}`

  return (
    <div className="flex h-16 items-end gap-1.5" role="img" aria-label={summary}>
      {buckets.map((b) => (
        <div key={b.key} className="relative flex-1 self-stretch" aria-hidden="true">
          {/* Faint full-height track so a zero-count column still reads. */}
          <div className="absolute inset-0 rounded-t bg-line" />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t bg-accent/70 transition-[height] duration-500 hover:brightness-125"
            style={{
              height: grown ? `${Math.max((b.count / max) * 100, b.count > 0 ? 6 : 2)}%` : 0
            }}
            title={`${b.label}: ${b.count} call${b.count === 1 ? '' : 's'}`}
          />
        </div>
      ))}
    </div>
  )
}

/** Projected open-deal value per month. Tone-colored (accent) like the rest
 *  of the screen's non-graded volume bars, with a compact currency value
 *  above each bar and the month/bucket label below — mirrors `ActivityBars`'
 *  structure, accessibility treatment, and mount animation. */
export function PipelineForecastBars({
  buckets
}: {
  buckets: PipelineForecastBucket[]
}): React.JSX.Element {
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const max = buckets.reduce((m, b) => Math.max(m, b.totalValue), 0) || 1
  const total = buckets.reduce((sum, b) => sum + b.totalValue, 0)
  const summary =
    buckets.length === 0
      ? 'No pipeline data'
      : `Pipeline forecast: ${formatCompactCurrency(total)} total across ${buckets.length} bucket${buckets.length === 1 ? '' : 's'}, from ${buckets[0].monthLabel} to ${buckets[buckets.length - 1].monthLabel}`

  return (
    <div role="img" aria-label={summary}>
      <div className="flex h-16 items-end gap-1.5">
        {buckets.map((b) => (
          <div key={b.monthKey} className="relative flex-1 self-stretch" aria-hidden="true">
            {/* Faint full-height track so a zero-value column still reads. */}
            <div className="absolute inset-0 rounded-t bg-line" />
            <div
              className="absolute inset-x-0 bottom-0 rounded-t bg-accent/70 transition-[height] duration-500 hover:brightness-125"
              style={{
                height: grown
                  ? `${Math.max((b.totalValue / max) * 100, b.totalValue > 0 ? 6 : 2)}%`
                  : 0
              }}
              title={`${b.monthLabel}: ${formatCompactCurrency(b.totalValue)} across ${b.dealCount} deal${b.dealCount === 1 ? '' : 's'}`}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5" aria-hidden="true">
        {buckets.map((b) => (
          <div key={b.monthKey} className="flex-1 text-center">
            <p className="text-[11px] font-medium tabular-nums text-muted">
              {b.dealCount > 0 ? formatCompactCurrency(b.totalValue) : '—'}
            </p>
            <p className="text-[10px] text-faint">{b.monthLabel}</p>
          </div>
        ))}
      </div>
    </div>
  )
}
