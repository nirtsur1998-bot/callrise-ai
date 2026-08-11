import { cn } from '@renderer/lib/cn'

const SEGMENTS = 5

interface ConfidenceMeterProps {
  /** 0..1. */
  confidence: number
  /** Segment fill color, matches the nudge type's tone. */
  fillClassName: string
  className?: string
}

/**
 * A 5-bar signal meter plus its exact percentage — not one or the other.
 *
 * The bars are what the eye actually uses mid-call: five height-graduated
 * segments read "mostly sure" vs. "borderline" in the same glance as the
 * type icon next to them, no legend required. The number exists for the
 * moment a glance isn't enough — a rep deciding whether to act on a 61%
 * "risk" call deserves the real figure, not just "3 of 5 bars" — and
 * tabular-nums keeps it from jittering the layout as it changes between
 * nudges.
 */
export function ConfidenceMeter({
  confidence,
  fillClassName,
  className
}: ConfidenceMeterProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(1, confidence))
  // Never show a fully-dark meter: every nudge reaching this component
  // already cleared the engine's quality bar, so a zero-filled meter would
  // misrepresent a signal the product itself decided was worth surfacing.
  const filled = Math.max(1, Math.round(clamped * SEGMENTS))

  return (
    <div
      className={cn('flex items-center gap-1.5', className)}
      role="img"
      aria-label={`Confidence ${Math.round(clamped * 100)} percent`}
    >
      <div className="flex items-end gap-[3px]" aria-hidden="true">
        {Array.from({ length: SEGMENTS }, (_, index) => (
          <span
            key={index}
            className={cn(
              'w-[3px] rounded-full transition-colors duration-300',
              index < filled ? fillClassName : 'bg-line'
            )}
            style={{ height: 5 + index * 2 }}
          />
        ))}
      </div>
      <span className="text-[10px] font-medium text-faint tabular-nums">
        {Math.round(clamped * 100)}%
      </span>
    </div>
  )
}
