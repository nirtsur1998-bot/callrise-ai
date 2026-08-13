import { PhoneCall, RefreshCw } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { useLiveCall } from './useLiveCall'
import { goToLiveCalls } from './liveCallNav'

/**
 * M26 Phase 4.6 — "a persistent live-call pill," the one piece named but not
 * yet built when Phase 4.4's scope note was written. Phase 4 (4.1-4.4) and
 * BUG-055 made the call itself, and the cue/deal-intelligence engines,
 * survive navigation — but nothing anywhere outside the Live Calls screen
 * ever told the rep a call was STILL RUNNING while they were looking at
 * Settings, Contacts, anywhere else. That's not cosmetic: it's the same
 * "forgot it was still going" risk BUG-046 was about, just for attention
 * instead of data loss.
 *
 * Rendered as a fixed-position overlay from App.tsx, a sibling of MainApp —
 * same reason as ActivityCenter/InterruptedCallPrompt (see ActivityCenter.tsx's
 * own doc comment): MainApp swaps to a wholly separate tree for Settings, so
 * anything placed inside either branch would disappear exactly when the rep
 * navigates to the one place this is most likely to matter.
 */
export function LiveCallPill(): React.JSX.Element | null {
  const { status } = useLiveCall()

  // Only the states where a real, ongoing session exists — not while
  // starting up, not after it's stopped or failed to start. Those already
  // have their own on-screen feedback on the Live Calls view itself; a rep
  // who isn't there yet has nothing running to be reminded about.
  if (status !== 'listening' && status !== 'paused' && status !== 'reconnecting') return null

  const label =
    status === 'reconnecting' ? 'Reconnecting…' : status === 'paused' ? 'Call paused' : 'Live call'
  const tone =
    status === 'reconnecting'
      ? 'border-warning/30 bg-warning-soft text-warning'
      : status === 'paused'
        ? 'border-line-soft bg-canvas text-muted'
        : 'border-danger/30 bg-danger-soft text-danger'

  return (
    <button
      type="button"
      onClick={goToLiveCalls}
      title="Back to Live Calls"
      className={cn(
        'fixed top-3 left-1/2 z-50 -translate-x-1/2',
        'flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium shadow-sm',
        'transition hover:brightness-95',
        tone
      )}
    >
      {status === 'reconnecting' ? (
        <RefreshCw className="h-3 w-3 animate-spin" />
      ) : status === 'listening' ? (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-danger" />
        </span>
      ) : (
        <span className="inline-flex h-2 w-2 rounded-full bg-muted" />
      )}
      {label}
      <PhoneCall className="h-3 w-3" />
    </button>
  )
}
