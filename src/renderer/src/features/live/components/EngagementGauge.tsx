import { cn } from '@renderer/lib/cn'

interface EngagementGaugeProps {
  /** 0–100 rolling estimate. Caller only mounts this once the score is
   *  non-null (see useLiveCues' engagementScore). */
  score: number
  className?: string
}

/**
 * A small "live" read of conversational engagement — deliberately NOT a
 * coaching or AI-derived score. It's a rough, local approximation computed
 * from talk-ratio balance, question frequency, and reply pace over the
 * transcript already on screen (see computeEngagementScore in useLiveCues.ts
 * for the exact formula). Styled distinctly from ScoreGauge (smaller, a
 * pulsing "live" dot, a plain accent ring, an "approx." caption + tooltip) so
 * it never reads as a graded result.
 */
export function EngagementGauge({ score, className }: EngagementGaugeProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(100, Math.round(score)))
  const size = 36
  const stroke = 3
  const r = (size - stroke) / 2
  const circumference = 2 * Math.PI * r
  const offset = circumference * (1 - clamped / 100)

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-xl border border-line-soft bg-surface px-2.5 py-1.5',
        className
      )}
      title="Engagement (approximate) — a rough, local estimate from talk balance, questions asked, and reply pace in this call. Not an AI or coaching score."
    >
      <div
        className="relative grid shrink-0 place-items-center"
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
            className="stroke-accent transition-[stroke-dashoffset] duration-700 ease-out"
          />
        </svg>
        <span className="absolute text-[10px] font-semibold tabular-nums text-ink">{clamped}</span>
      </div>
      <div className="flex flex-col leading-tight">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-faint">
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="pulse-ring absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          Engagement
        </span>
        <span className="text-[10px] text-faint">approx., not AI</span>
      </div>
    </div>
  )
}
