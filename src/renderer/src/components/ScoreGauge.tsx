import { useEffect, useRef, useState } from 'react'
import { cn } from '@renderer/lib/cn'

export type GaugeTone = 'positive' | 'warning' | 'danger' | 'neutral'

const STROKE: Record<GaugeTone, string> = {
  positive: 'stroke-positive',
  warning: 'stroke-warning',
  danger: 'stroke-danger',
  neutral: 'stroke-faint'
}
const TEXT: Record<GaugeTone, string> = {
  positive: 'text-positive',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-ink'
}

/** Default tone from a 0–100 score when the caller doesn't supply one. */
function toneFor(score: number): GaugeTone {
  if (score >= 65) return 'positive'
  if (score >= 50) return 'warning'
  return 'danger'
}

interface ScoreGaugeProps {
  /** 0–100. */
  score: number
  /** px diameter. Small sizes drop the "/100" caption automatically. */
  size?: number
  tone?: GaugeTone
  className?: string
}

/**
 * A radial 0–100 score dial — the app's headline number, systematized. Use the
 * larger size as the coaching-report hero; the compact size as the score chip
 * in coaching/past-calls lists. The ring animates in via CSS on the offset.
 */
export function ScoreGauge({
  score,
  size = 96,
  tone,
  className
}: ScoreGaugeProps): React.JSX.Element {
  const t = tone ?? toneFor(score)
  const clamped = Math.max(0, Math.min(100, Math.round(score)))
  const stroke = size < 56 ? 4 : 6
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const offset = circumference * (1 - clamped / 100)
  const showCaption = size >= 72

  // Counts the center number up alongside the ring's 700ms CSS transition.
  // Continues from wherever the previous animation left off (rather than
  // always resetting to 0), so a changed score keeps momentum the same way
  // the ring's stroke-dashoffset continues from its current position.
  const [displayValue, setDisplayValue] = useState(clamped)
  const prevValueRef = useRef(clamped)

  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const from = prevValueRef.current
    const to = clamped

    if (prefersReducedMotion || from === to) {
      setDisplayValue(to)
      prevValueRef.current = to
      return
    }

    const duration = 700
    const start = performance.now()
    let raf = 0
    let latest = from

    const tick = (now: number): void => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3) // ease-out cubic, matches the ring's ease-out
      latest = from + (to - from) * eased
      setDisplayValue(latest)
      if (progress < 1) {
        raf = requestAnimationFrame(tick)
      } else {
        prevValueRef.current = to
      }
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      // Preserve however far the count-up got, so an interrupted animation
      // (rapid score changes) resumes from there instead of jumping back.
      prevValueRef.current = latest
    }
  }, [clamped])

  return (
    <div
      className={cn('relative grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-line-soft"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn(STROKE[t], 'transition-[stroke-dashoffset] duration-700 ease-out')}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={cn('font-semibold tabular-nums', TEXT[t])}
          style={{ fontSize: size * 0.28 }}
        >
          {Math.round(displayValue)}
        </span>
        {showCaption && <span className="text-[10px] text-faint">/ 100</span>}
      </div>
    </div>
  )
}
