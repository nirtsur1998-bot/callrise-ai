import { cn } from '@renderer/lib/cn'
import type { DealIntelligenceStatus } from './types'

const STATUS_WORD: Record<DealIntelligenceStatus, string> = {
  idle: 'Calibrating',
  active: 'Watching',
  paused: 'Paused',
  'timed-out': 'Paused',
  'quota-exhausted': 'Paused'
}

const STATUS_TEXT_TONE: Record<DealIntelligenceStatus, string> = {
  idle: 'text-faint',
  active: 'text-accent',
  paused: 'text-warning',
  'timed-out': 'text-warning',
  'quota-exhausted': 'text-warning'
}

const STATUS_DESCRIPTION: Record<DealIntelligenceStatus, string> = {
  idle: 'Deal intelligence warming up — calibrating on this call',
  active: 'Deal intelligence active — watching the call for signals',
  paused: 'Deal intelligence paused — provider chain unreachable, resumes automatically',
  // BUG-057 Phase 2 — same dot/label as 'paused' (the compact pill has no
  // room for the distinction), but the full-sentence screen-reader text and
  // StatusNotice's own card (which DOES have room) say something true.
  'timed-out': 'Deal intelligence paused — the model is taking too long to respond, resumes automatically',
  // BUG-058 Phase 3 — same reasoning as 'timed-out' above.
  'quota-exhausted':
    "Deal intelligence paused — a configured model's free-tier quota is used up, add another provider's key or wait for it to reset"
}

interface PresenceDotProps {
  status: DealIntelligenceStatus
  /** Briefly true right after a new nudge lands — flashes the dot once so an
   *  incoming card reads as having arrived FROM this exact point, rather than
   *  the dot being a decorative status light that happens to sit near a list.
   *  This is the single element on screen for the entire length of a call in
   *  every status: unlike a nudge card it never unmounts, which is what
   *  actually makes "we watch continuously, unlike after-the-fact analytics"
   *  something felt on screen instead of only claimed in copy. */
  justArrived: boolean
}

function PresenceDot({ status, justArrived }: PresenceDotProps): React.JSX.Element {
  return (
    <span className="relative grid h-2.5 w-2.5 shrink-0 place-items-center">
      {status === 'active' && (
        // Reuses the app's existing breathing-halo utility rather than a
        // bespoke keyframe — a rotating conic sweep was tried in an earlier
        // concept and read as too much theatrics for a corner indicator that
        // has to sit on screen for an entire call without becoming a fidget.
        <span
          aria-hidden="true"
          className="pulse-ring absolute inset-0 rounded-full bg-accent/70"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          'relative h-2.5 w-2.5 rounded-full transition-colors duration-300',
          status === 'active' && 'bg-accent shadow-[0_0_8px_1px_var(--color-accent)]',
          status === 'idle' && 'bg-faint/60',
          // BUG-057 Phase 2 — 'timed-out' shares 'paused''s dot colour
          // deliberately (this is not a Record, so a missing case here
          // silently renders no colour at all rather than a compile error —
          // checked explicitly for exactly that reason). BUG-058 Phase 3 —
          // 'quota-exhausted' too.
          (status === 'paused' || status === 'timed-out' || status === 'quota-exhausted') && 'bg-warning',
          // One-shot accent glow — the app's existing "this just changed"
          // idiom (see PipelineBoard's flash-on-move) reused here for "a
          // signal just arrived" instead of a new keyframe.
          justArrived && 'flash'
        )}
      />
    </span>
  )
}

/**
 * The one element that is on screen for the entire call regardless of
 * status — a slim identity pill rather than the wider two-row masthead an
 * earlier draft used (icon + label card, plus a separate always-visible
 * "quiet is normal" notice underneath it). That combo cost real height
 * through the quiet majority of a call, which is exactly the state the
 * product's own framing says is typical; collapsing it to one pill with a
 * living dot keeps the "is this thing alive" proof without the permanent
 * footprint.
 */
export function PresenceHeader({
  status,
  justArrived
}: {
  status: DealIntelligenceStatus
  justArrived: boolean
}): React.JSX.Element {
  return (
    <div className="glass-hud pointer-events-auto flex items-center gap-2 rounded-full px-3 py-1.5">
      <PresenceDot status={status} justArrived={justArrived} />
      <span className="sr-only">{STATUS_DESCRIPTION[status]}</span>
      <span
        aria-hidden="true"
        className="text-[10px] font-semibold tracking-wide text-faint uppercase"
      >
        Deal Intelligence
      </span>
      <span
        aria-hidden="true"
        className={cn('ml-auto text-[10px] font-medium', STATUS_TEXT_TONE[status])}
      >
        {STATUS_WORD[status]}
      </span>
    </div>
  )
}
