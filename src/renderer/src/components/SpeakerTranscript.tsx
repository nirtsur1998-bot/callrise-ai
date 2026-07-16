import { cn } from '@renderer/lib/cn'
import type { CallSegment } from '@renderer/features/calls/types'
import { speakerLabel } from '@renderer/features/coaching/meta'

// A distinct color per speaker (cycles for many speakers), using the
// theme-aware decorative speaker palette (not the status-color tokens).
const SPEAKER_STYLES = [
  { dot: 'bg-speaker-1', label: 'text-speaker-1' },
  { dot: 'bg-speaker-2', label: 'text-speaker-2' },
  { dot: 'bg-speaker-3', label: 'text-speaker-3' },
  { dot: 'bg-speaker-4', label: 'text-speaker-4' },
  { dot: 'bg-speaker-5', label: 'text-speaker-5' },
  { dot: 'bg-speaker-6', label: 'text-speaker-6' }
]

// The dominant real-world case (a 1:1 rep/buyer call) gets its own calmer
// treatment instead of the decorative palette: the rep reads as the app's
// accent color, the buyer as a neutral — closer to how the rest of the UI
// already distinguishes "you" from everyone else.
const REP_STYLE = { dot: 'bg-accent', label: 'text-accent' }
const BUYER_STYLE = { dot: 'bg-faint', label: 'text-muted' }

function speakerStyle(
  speaker: number,
  repSpeaker: number | null,
  speakerCount: number
): { dot: string; label: string } {
  if (repSpeaker !== null && speakerCount <= 2) {
    return speaker === repSpeaker ? REP_STYLE : BUYER_STYLE
  }
  return SPEAKER_STYLES[speaker % SPEAKER_STYLES.length]
}

interface SpeakerTranscriptProps {
  segments: CallSegment[]
  /** In-progress words (shown faint). Live view only. */
  interimText?: string
  /** The rep's speaker id, when known — renders "You"/"Buyer" instead of the
   *  raw "Speaker N" label. Pass null (or omit) when the rep isn't identified. */
  repSpeaker?: number | null
}

/** Renders a transcript grouped into speaker turns. Shared by the Live view
 *  and the saved-call detail view. */
export function SpeakerTranscript({
  segments,
  interimText,
  repSpeaker = null
}: SpeakerTranscriptProps): React.JSX.Element {
  const speakerCount = new Set(segments.map((s) => s.speaker)).size
  return (
    <div className="space-y-5">
      {segments.map((seg, index) => {
        const style = speakerStyle(seg.speaker, repSpeaker, speakerCount)
        return (
          <div key={index}>
            <div className="mb-1 flex items-center gap-2">
              <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
              <span className={cn('text-xs font-semibold uppercase tracking-wide', style.label)}>
                {speakerLabel(seg.speaker, repSpeaker, speakerCount)}
              </span>
            </div>
            <p className="text-[17px] leading-[1.7] text-ink">{seg.text}</p>
          </div>
        )
      })}
      {interimText ? <p className="text-[17px] leading-[1.7] text-faint">{interimText}</p> : null}
    </div>
  )
}
