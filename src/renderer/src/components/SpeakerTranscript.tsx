import { cn } from '@renderer/lib/cn'
import type { CallSegment } from '@renderer/features/calls/types'

// A distinct color per speaker (cycles for many speakers).
const SPEAKER_STYLES = [
  { dot: 'bg-indigo-400', label: 'text-indigo-300' },
  { dot: 'bg-emerald-400', label: 'text-emerald-300' },
  { dot: 'bg-amber-400', label: 'text-amber-300' },
  { dot: 'bg-sky-400', label: 'text-sky-300' },
  { dot: 'bg-rose-400', label: 'text-rose-300' },
  { dot: 'bg-violet-400', label: 'text-violet-300' }
]

function speakerStyle(speaker: number): { dot: string; label: string } {
  return SPEAKER_STYLES[speaker % SPEAKER_STYLES.length]
}

interface SpeakerTranscriptProps {
  segments: CallSegment[]
  /** In-progress words (shown faint). Live view only. */
  interimText?: string
}

/** Renders a transcript grouped into speaker turns. Shared by the Live view
 *  and the saved-call detail view. */
export function SpeakerTranscript({
  segments,
  interimText
}: SpeakerTranscriptProps): React.JSX.Element {
  return (
    <div className="space-y-5">
      {segments.map((seg, index) => {
        const style = speakerStyle(seg.speaker)
        return (
          <div key={index}>
            <div className="mb-1 flex items-center gap-2">
              <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
              <span
                className={cn('text-xs font-semibold uppercase tracking-wide', style.label)}
              >
                Speaker {seg.speaker + 1}
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
