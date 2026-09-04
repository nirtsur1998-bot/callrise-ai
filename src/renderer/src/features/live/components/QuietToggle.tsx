import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@renderer/lib/cn'

/**
 * M34 3c-A — the live screen's Quiet switch.
 *
 * On: the between-turn instruments go away — the engagement gauge, the
 * monologue meter, the suggestion rail (collapsed to a count) and the
 * deal-intelligence panel. What stays is everything a talking person can
 * actually use: the transcript (proof capture is alive), the must-ask strip,
 * the waveform, the status/health readout, the consent control, and the ONE
 * deterministic interrupt cue — the cues mute beside this switch is how a rep
 * silences that too.
 *
 * Live and reversible mid-call, so the answer to "what do I want on screen"
 * is found ON a call rather than predicted in Settings. Hides, never unmounts
 * the engines: everything keeps computing and comes back with current state.
 */
export function QuietToggle({
  quiet,
  onToggle
}: {
  quiet: boolean
  onToggle: (v: boolean) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onToggle(!quiet)}
      aria-pressed={quiet}
      title={
        quiet
          ? 'Quiet is on — gauge, meter, suggestions and deal panel are hidden. Click to show them.'
          : 'Quiet — hide the gauge, meter, suggestions and deal panel. The transcript, checklist, health and the interrupt cue stay.'
      }
      className={cn(
        'no-drag flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition',
        quiet ? 'border-accent/40 bg-accent-soft text-ink' : 'border-line text-muted hover:text-ink'
      )}
    >
      {quiet ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      {quiet ? 'Quiet' : 'Quiet'}
    </button>
  )
}
