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
      <div className="no-drag flex items-center gap-3 rounded-xl border border-accent/30 bg-surface px-4 py-3 shadow-pop">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft">
          <PhoneCall className="h-4 w-4 text-accent" />
        </div>
        <p className="text-[13px] text-ink">
          Looks like you&rsquo;re on a call in <span className="font-medium">{appName}</span>. Want
          CallRise AI to transcribe it?
        </p>
        <Button size="sm" onClick={onStart}>
          Start transcribing
        </Button>
        <IconButton icon={X} label="Dismiss" onClick={onDismiss} />
      </div>
    </div>
  )
}
