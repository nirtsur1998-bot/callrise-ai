import { PhoneCall, Loader2, Check } from 'lucide-react'
import type { OnboardingState } from '../useOnboarding'

/** Closing screen: a one-line recap of what got set, then the two exits. */
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
  const cues = o.cuesEnabled
    ? `on, ${o.sensitivity === 'low' ? 'calm' : o.sensitivity === 'medium' ? 'balanced' : 'active'}`
    : 'off'
  const recording = o.recordBothSides ? 'both sides, with consent' : 'my side only'

  return (
    <div className="text-center">
      <div className="mx-auto mb-4 grid h-11 w-11 place-items-center rounded-full bg-emerald-500/15">
        <Check className="h-5 w-5 text-emerald-300" strokeWidth={2.5} />
      </div>
      <h1 className="text-xl font-semibold tracking-tight">You’re all set</h1>
      <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-muted">
        You’re <span className="text-ink">{who}</span>. Cues are{' '}
        <span className="text-ink">{cues}</span>. Recording:{' '}
        <span className="text-ink">{recording}</span>.
      </p>

      <div className="mt-6 space-y-2.5">
        <button
          type="button"
          onClick={onStartCall}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3.5 py-2.5 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneCall className="h-4 w-4" />}
          Start my first call
        </button>
        <button
          type="button"
          onClick={onExplore}
          disabled={busy}
          className="w-full rounded-lg px-3.5 py-2.5 text-sm font-medium text-muted transition hover:text-ink disabled:opacity-50"
        >
          Explore the app
        </button>
      </div>
    </div>
  )
}
