import { PhoneCall, X } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import { IconButton } from '@renderer/components/IconButton'

interface CallDetectedBannerProps {
  /** The known-calling-app name that was detected (e.g. "WhatsApp", "Zoom"). */
  appName: string
  onStart: () => void
  onDismiss: () => void
}

/** A top-of-page prompt when a known calling app (WhatsApp, Zoom, Teams,
 *  MicroSIP, …) becomes frontmost while the rep is away from CallRise AI —
 *  a heuristic "looks like you're on a call" nudge, never a guarantee, and
 *  never starts capture without this explicit click (that's what the
 *  separate "Auto-transcribe" toggle is for). */
export function CallDetectedBanner({
  appName,
  onStart,
  onDismiss
}: CallDetectedBannerProps): React.JSX.Element {
  return (
    <div className="animate-pop fixed inset-x-0 top-3 z-50 flex justify-center px-4">
      {/* A capsule, not a rectangle. This is a single row that floats over the
          app — the shape the eye reads as "a notification, not a panel" — and
          `rounded-full` on a fixed-height row gives true continuous ends
          rather than four corners rounded by an arbitrary amount.

          Bounded and wrap-tolerant too: the sentence carries a variable app
          name, so an unbounded row clips its own button on a narrow window. */}
      <div className="glass-hud no-drag relative flex w-full max-w-2xl items-center gap-3 rounded-full py-2.5 pr-2.5 pl-3">
        <span className="glass-sheen rounded-full" />
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft ring-1 ring-accent/25">
          <PhoneCall className="h-4 w-4 text-accent" />
        </div>
        <p className="min-w-0 flex-1 text-[13px] text-ink">
          Looks like you&rsquo;re on a call in <span className="font-medium">{appName}</span>. Want
          CallRise AI to transcribe it?
        </p>
        <Button size="sm" className="shrink-0 rounded-full" onClick={onStart}>
          Start transcribing
        </Button>
        <span className="shrink-0">
          <IconButton icon={X} label="Dismiss" onClick={onDismiss} className="rounded-full" />
        </span>
      </div>
    </div>
  )
}
