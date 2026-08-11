import { AlertTriangle } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

type NoticeVariant = 'idle' | 'quiet' | 'paused'

const COPY: Record<NoticeVariant, string> = {
  idle: 'Calibrating on this call — the first read needs a few turns of real signal.',
  quiet:
    "Nothing rare enough to flag yet. Quiet is normal — most of a call doesn't earn an interruption.",
  paused:
    'Live intelligence is temporarily unavailable — the model provider chain is unreachable or rate-limited. Resumes automatically; transcription is unaffected.'
}

/**
 * Explains why the panel currently has nothing else to show. Silence reads
 * as "broken" in any live tool unless the product accounts for it — this
 * mirrors the live view's existing "AI coaching paused" banner in tone,
 * scaled to this panel's own footprint rather than a full-width strip.
 *
 * `idle` and `paused` are rendered by the caller for as long as those
 * statuses hold; `quiet` is deliberately NOT — see the grace-window logic in
 * DealIntelligencePanel. A permanent "quiet is normal" card would itself
 * become the permanent fixture the copy is busy insisting this feature
 * isn't, so this component only ever renders what its caller tells it to.
 */
export function StatusNotice({ variant }: { variant: NoticeVariant }): React.JSX.Element {
  const isPaused = variant === 'paused'
  return (
    <div
      className={cn(
        'glass-hud pointer-events-auto rounded-2xl px-3 py-2.5',
        isPaused && 'ring-1 ring-warning/30 ring-inset'
      )}
    >
      <div className="flex items-start gap-2">
        {isPaused && (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
        )}
        <p className="text-[12px] leading-snug text-muted">{COPY[variant]}</p>
      </div>
    </div>
  )
}
