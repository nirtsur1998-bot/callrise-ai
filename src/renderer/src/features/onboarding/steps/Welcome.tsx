import { ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/Button'

/** The opening screen — no data collected, just the pitch and the two doors. */
export function Welcome({
  onStart,
  onSkip,
  busy
}: {
  onStart: () => void
  onSkip: () => void
  busy: boolean
}): React.JSX.Element {
  return (
    <div className="text-center">
      <h1 className="text-xl font-semibold tracking-tight">Welcome to CallRise AI</h1>
      <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-muted">
        Two minutes to set up. It makes your summaries and coaching sound like they actually know
        you — not generic sales advice.
      </p>

      <div className="mt-6 space-y-2.5">
        <Button fullWidth onClick={onStart} disabled={busy} icon={ArrowRight} iconPosition="right">
          Get started
        </Button>
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg px-3.5 py-2.5 text-sm font-medium text-muted transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          Skip setup
        </button>
      </div>
    </div>
  )
}
