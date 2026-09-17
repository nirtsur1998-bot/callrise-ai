import { cn } from '@renderer/lib/cn'
import type { CallSegment } from '@renderer/features/calls/types'
import type { LiveStatus } from '@renderer/features/live/types'
import type { TranscriptionHealthEvent } from '../../../../../preload/index.d'
import { StatusBadge } from '@renderer/features/live/components/LiveStates'
import { sessionHealthNotice } from '@renderer/features/live/session-health-notice'
import { formatLiveDealFacts, type LiveDealFacts } from '@renderer/features/live/dealFacts'
import { talkShare, whoIsSpeaking, type Speaking } from './hudCore'

/** The talk-share mark: above this share of the words the bar turns to
 *  warning, and the tick on the track shows where that line is. */
const TALK_SHARE_TICK = 0.65

/**
 * M36 Stage 2 — THE STATE STRIP. Facts that are true by construction and
 * never judgements: the session state (already honest), who is talking (with
 * UNSURE kept visible), talk share as measured words, the deal facts line
 * folded in (the founder's amendment: one glance at "Proposal · high risk"
 * changes how they talk, and it is static — it competes with nothing), and
 * a capture or lag problem shown as a state in place of any cue.
 *
 * INSTRUMENT PANEL: two weights, not one. The status and the health chip are
 * the things that can be WRONG mid-call, so they keep their colour and
 * weight; everything measured — who is talking, the share, the deal facts —
 * is muted mono, readouts on a panel rather than headlines. The speaking dot
 * no longer changes colour per speaker: it is one dot with a ring when
 * someone is talking, and the word beside it says who.
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
  const speaking: Speaking = whoIsSpeaking(
    latest && latestAt !== null ? { role: latest.role, at: latestAt } : null,
    now
  )
  const share = talkShare(segments)
  const notice = sessionHealthNotice(health)
  const deal = dealFacts ? formatLiveDealFacts(dealFacts).parts : []
  const sharePct = share.youShare === null ? null : Math.round(share.youShare * 100)

  return (
    <div
      data-testid="state-strip"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-dense text-muted"
    >
      <StatusBadge status={status} />
      {notice && (
        <span
          data-testid="strip-health"
          className="rounded-md border border-warning/40 bg-warning-soft px-2 py-0.5 text-2xs font-semibold text-warning"
          title={notice.title}
        >
          {notice.label}
        </span>
      )}
      <span
        data-testid="strip-speaking"
        className="flex items-center gap-1.5 font-mono text-2xs tabular-nums"
      >
        <span
          className={cn(
            'inline-block h-2 w-2 rounded-full bg-faint',
            speaking !== 'nobody' && 'ring-1 ring-ink'
          )}
        />
        {speaking === 'you'
          ? 'you'
          : speaking === 'them'
            ? 'them'
            : speaking === 'unsure'
              ? 'unsure who'
              : 'quiet'}
      </span>
      <span
        data-testid="strip-talkshare"
        className="flex items-center gap-2 font-mono text-2xs tabular-nums"
        title={
          share.youShare === null
            ? 'No attributed words yet'
            : `${share.youWords} of your words, ${share.themWords} of theirs${share.unsureWords ? `, ${share.unsureWords} unsure (not counted)` : ''}`
        }
      >
        <span className="text-faint">you</span>
        <span className="relative h-[3px] w-24">
          <span className="absolute inset-0 overflow-hidden rounded-full bg-line">
            <span
              className={cn(
                'block h-full rounded-full',
                share.youShare !== null && share.youShare > TALK_SHARE_TICK
                  ? 'bg-warning'
                  : 'bg-accent'
              )}
              style={{ width: `${sharePct ?? 0}%` }}
            />
          </span>
          {/* The 65% mark, so the bar says where the line is before it is crossed. */}
          <span
            aria-hidden="true"
            className="absolute top-1/2 h-[7px] w-px -translate-y-1/2 bg-line-strong"
            style={{ left: `${TALK_SHARE_TICK * 100}%` }}
          />
        </span>
        <span>{sharePct === null ? '—' : `${sharePct}%`}</span>
      </span>
      {deal.length > 0 && (
        <span
          data-testid="strip-deal"
          className="truncate font-mono text-2xs tabular-nums text-muted"
          title={deal.join(' · ')}
        >
          {deal.join(' · ')}
        </span>
      )}
    </div>
  )
}
