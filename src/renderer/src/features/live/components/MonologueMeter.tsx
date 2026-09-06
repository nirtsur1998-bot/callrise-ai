import { Tooltip } from '@renderer/components/Tooltip'
import { cn } from '@renderer/lib/cn'
import { formatMonologue, type MonologueState } from '../monologue'

interface MonologueMeterProps {
  state: MonologueState
  className?: string
}

const TONE_CLASS: Record<MonologueState['tone'], string> = {
  neutral: 'text-faint',
  good: 'text-faint',
  warn: 'text-warning',
  high: 'text-danger'
}

const DOT_CLASS: Record<MonologueState['tone'], string> = {
  neutral: 'bg-line',
  good: 'bg-positive',
  warn: 'bg-warning',
  high: 'bg-danger'
}

/**
 * A passive read of the rep's current run of uninterrupted speech (§4.2).
 *
 * Deliberately inert: the number ticks and the colour shifts, and that is the
 * entire interaction. No modal, no cue, no interrupt — see monologue.ts for
 * why a live talk-ratio nudge is worse than the problem it would be fixing.
 * Styled as EngagementGauge's sibling (same border/pill shell, same "glance,
 * don't announce" register) rather than borrowing ScoreGauge's graded look,
 * since this is no more a coaching verdict than engagement is.
 */
export function MonologueMeter({ state, className }: MonologueMeterProps): React.JSX.Element {
  return (
    <Tooltip
      content="How long you've been talking without the other side getting a word in. Never interrupts — glance, don't wait for it to tell you."
      className="max-w-sm"
    >
      <div
        className={cn(
          'flex items-center gap-2 rounded-xl border border-line-soft bg-surface px-2.5 py-1.5',
          className
        )}
      >
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_CLASS[state.tone])} />
        <div className="flex flex-col leading-tight">
          <span className={cn('text-[11px] font-medium tabular-nums', TONE_CLASS[state.tone])}>
            {formatMonologue(state.ms)}
          </span>
          <span className="text-[10px] text-faint">you, uninterrupted</span>
        </div>
      </div>
    </Tooltip>
  )
}
