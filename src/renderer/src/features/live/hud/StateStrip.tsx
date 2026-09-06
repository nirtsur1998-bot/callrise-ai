import { cn } from '@renderer/lib/cn'
import type { CallSegment } from '@renderer/features/calls/types'
import type { LiveStatus } from '@renderer/features/live/types'
import type { TranscriptionHealthEvent } from '../../../../../preload/index.d'
import { StatusBadge } from '@renderer/features/live/components/LiveStates'
import { sessionHealthNotice } from '@renderer/features/live/session-health-notice'
import { formatLiveDealFacts, type LiveDealFacts } from '@renderer/features/live/dealFacts'
import { talkShare, whoIsSpeaking, type Speaking } from './hudCore'

/**
 * M36 Stage 2 — THE STATE STRIP. Facts that are true by construction and
 * never judgements: the session state (already honest), who is talking (with
 * UNSURE kept visible), talk share as measured words, the deal facts line
 * folded in (the founder's amendment: one glance at "Proposal · high risk"
 * changes how they talk, and it is static — it competes with nothing), and
 * a capture or lag problem shown as a state in place of any cue.
 */
export function StateStrip({
  status,
  health,
  segments,
  latestAt,
  now,
  dealFacts
}: {
  status: LiveStatus
  health: TranscriptionHealthEvent | null
  segments: CallSegment[]
  /** Monotonic ms of the latest segment/interim, for "who is talking". */
  latestAt: number | null
  now: number
  dealFacts: LiveDealFacts | null
}): React.JSX.Element {
  const latest = segments.length > 0 ? segments[segments.length - 1] : null
  const speaking: Speaking = whoIsSpeaking(latest && latestAt !== null ? { role: latest.role, at: latestAt } : null, now)
  const share = talkShare(segments)
  const notice = sessionHealthNotice(health)
  const deal = dealFacts ? formatLiveDealFacts(dealFacts).parts : []

  return (
    <div data-testid="state-strip" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted">
      <StatusBadge status={status} />
      {notice && (
        <span
          data-testid="strip-health"
          className="rounded-md border border-warning/40 bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning"
          title={notice.title}
        >
          {notice.label}
        </span>
      )}
      <span data-testid="strip-speaking" className="flex items-center gap-1.5">
        <span
          className={cn(
            'inline-block h-2 w-2 rounded-full',
            speaking === 'you' ? 'bg-accent' : speaking === 'them' ? 'bg-positive' : speaking === 'unsure' ? 'bg-warning' : 'bg-line'
          )}
        />
        {speaking === 'you' ? 'you' : speaking === 'them' ? 'them' : speaking === 'unsure' ? 'unsure who' : 'quiet'}
      </span>
      <span
        data-testid="strip-talkshare"
        className="flex items-center gap-2"
        title={
          share.youShare === null
            ? 'No attributed words yet'
            : `${share.youWords} of your words, ${share.themWords} of theirs${share.unsureWords ? `, ${share.unsureWords} unsure (not counted)` : ''}`
        }
      >
        <span className="text-faint">you</span>
        <span className="h-1.5 w-24 overflow-hidden rounded-full bg-line">
          <span
            className={cn('block h-full rounded-full', share.youShare !== null && share.youShare > 0.65 ? 'bg-warning' : 'bg-accent')}
            style={{ width: `${Math.round((share.youShare ?? 0) * 100)}%` }}
          />
        </span>
        <span className="tabular-nums">{share.youShare === null ? '—' : `${Math.round(share.youShare * 100)}%`}</span>
      </span>
      {deal.length > 0 && (
        <span data-testid="strip-deal" className="truncate text-ink" title={deal.join(' · ')}>
          {deal.join(' · ')}
        </span>
      )}
    </div>
  )
}
