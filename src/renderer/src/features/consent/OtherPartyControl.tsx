import { ShieldCheck, Shield } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { supportsOtherPartyCapture } from '@renderer/lib/platform'
import type { ConsentController } from './useConsent'

interface OtherPartyControlProps {
  consent: ConsentController
  onOpen: () => void
}

/**
 * Live-screen control showing whether recording the other party is permitted.
 * It only ever OPENS the consent modal — it can never flip recording on
 * directly; that requires confirming consent inside the modal.
 */
export function OtherPartyControl({ consent, onOpen }: OtherPartyControlProps): React.JSX.Element {
  // Buyer-side capture rides on system-audio loopback (M12) — supported on
  // macOS and Windows, no Linux path. Rather than open a consent flow that
  // could never record, show an honest disabled chip there.
  if (!supportsOtherPartyCapture) {
    return (
      <span
        title="Recording the other party isn't available on this platform — your own mic still transcribes normally."
        className="no-drag flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-faint"
      >
        <Shield className="h-3.5 w-3.5" />
        Other party · unavailable
      </span>
    )
  }

  const on = consent.canRecord
  return (
    <button
      type="button"
      onClick={onOpen}
      title={
        on
          ? 'Recording the other party is on (consent recorded). Click to review.'
          : 'Recording the other party is off. Click to set up consent.'
      }
      className={cn(
        'no-drag flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
        on
          ? 'border-positive/40 bg-positive-soft text-positive'
          : 'border-line text-muted hover:text-ink'
      )}
    >
      {on ? <ShieldCheck className="h-3.5 w-3.5" /> : <Shield className="h-3.5 w-3.5" />}
      Other party
    </button>
  )
}
