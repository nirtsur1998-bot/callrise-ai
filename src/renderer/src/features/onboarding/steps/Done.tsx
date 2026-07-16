import { PhoneCall, Loader2, Check, User, Sparkles, Mic } from 'lucide-react'
import { Badge, type BadgeTone } from '@renderer/components/Badge'
import { Button } from '@renderer/components/Button'
import type { OnboardingState } from '../useOnboarding'

/** Closing screen: a three-row recap of what got set, then the two exits. */
export function Done({
  o,
  busy,
  onStartCall,
  onExplore
}: {
  o: OnboardingState
  busy: boolean
  onStartCall: () => void
  onExplore: () => void
}): React.JSX.Element {
  const who = [o.name.trim(), o.role.trim()].filter(Boolean).join(', ') || 'set up and ready'
  const cuesLabel = o.cuesEnabled
    ? o.sensitivity === 'low'
      ? 'On — calm'
      : o.sensitivity === 'medium'
        ? 'On — balanced'
        : 'On — active'
    : 'Off'
  const cuesTone: BadgeTone = o.cuesEnabled ? 'positive' : 'neutral'
  const recording = o.recordBothSides ? 'Both sides, with consent' : 'My side only'

  return (
    <div className="text-center">
      <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-full bg-positive-soft">
        <Check className="h-5 w-5 text-positive" strokeWidth={2.5} />
      </div>
      <h1 className="text-xl font-semibold tracking-tight">You’re all set</h1>

      <div className="mx-auto mt-5 max-w-xs space-y-2 rounded-xl border border-line-soft bg-canvas p-3.5 text-left">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[13px] text-muted">
            <User className="h-3.5 w-3.5 shrink-0 text-faint" /> You
          </span>
          <Badge className="max-w-[60%] truncate">{who}</Badge>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[13px] text-muted">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-faint" /> Coaching cues
          </span>
          <Badge tone={cuesTone}>{cuesLabel}</Badge>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-[13px] text-muted">
            <Mic className="h-3.5 w-3.5 shrink-0 text-faint" /> Recording
          </span>
          <Badge>{recording}</Badge>
        </div>
      </div>

      <div className="mt-6 space-y-2.5">
        <Button fullWidth onClick={onStartCall} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneCall className="h-4 w-4" />}
          Start my first call
        </Button>
        <button
          type="button"
          onClick={onExplore}
          disabled={busy}
          className="w-full rounded-lg px-3.5 py-2.5 text-sm font-medium text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          Explore the app
        </button>
      </div>
    </div>
  )
}
