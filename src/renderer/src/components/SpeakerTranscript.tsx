import { useEffect, useRef } from 'react'
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

// Not exported — a component file may only export components (Fast Refresh),
// so callers that need the same escaping (the transcript search box in
// CallDetail) keep their own tiny copy rather than importing this one.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface SpeakerTranscriptProps {
  segments: CallSegment[]
  /** In-progress words (shown faint). Live view only. */
  interimText?: string
  /** The rep's speaker id, when known — renders "You"/"Buyer" instead of the
   *  raw "Speaker N" label. Pass null (or omit) when the rep isn't identified. */
  repSpeaker?: number | null
  /** Case-insensitive substring to highlight (wrapped in `<mark>`) within the
   *  transcript text — used by the saved-call search box. Omit/empty for no
   *  highlighting; other callers (live view, ViewCallModal) leave this unset. */
  highlightQuery?: string
  /** 0-based index (across the whole transcript, in render order) of the
   *  "current" match — gets a stronger highlight and is scrolled into view.
   *  Ignored when `highlightQuery` is empty. */
  activeMatchIndex?: number
}

/** Renders a transcript grouped into speaker turns. Shared by the Live view
 *  and the saved-call detail view. */
export function SpeakerTranscript({
  segments,
  interimText,
  repSpeaker = null,
  highlightQuery,
  activeMatchIndex
}: SpeakerTranscriptProps): React.JSX.Element {
  // Gap markers belong to nobody, so they must not inflate the speaker count —
  // that count decides between the calm rep/buyer treatment and the multi-party
  // palette.
  const speakerCount = new Set(segments.filter((s) => s.kind !== 'gap').map((s) => s.speaker)).size
  const query = highlightQuery?.trim() ?? ''
  // Only ever read/written inside JSX (as the `ref` attribute) or the effect
  // below — never during render — so it doesn't trip the "no ref access
  // during render" rule.
  const containerRef = useRef<HTMLDivElement>(null)

  // Scroll the active match into view. Looked up by a `data-match-index`
  // attribute (rather than collecting per-mark refs, which would mean
  // writing to a ref during render) once rendering has committed.
  useEffect(() => {
    if (activeMatchIndex == null) return
    const el = containerRef.current?.querySelector<HTMLElement>(
      `mark[data-match-index="${activeMatchIndex}"]`
    )
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeMatchIndex, query])

  // A plain local variable (not a ref) — recreated fresh on every render call,
  // so it needs no reset step and never touches `.current` during render.
  let matchCounter = 0

  const renderText = (text: string): React.ReactNode => {
    if (!query) return text
    const re = new RegExp(`(${escapeRegExp(query)})`, 'gi')
    const parts = text.split(re)
    if (parts.length === 1) return text
    return parts.map((part, i) => {
      // `split` with a capturing group interleaves [text, match, text, match, …] —
      // odd indices are the captured matches.
      if (i % 2 === 0 || part === '') return part || null
      const idx = matchCounter++
      const isActive = idx === activeMatchIndex
      return (
        <mark
          key={i}
          data-match-index={idx}
          className={cn('rounded-sm', isActive ? 'bg-accent/45' : 'bg-accent/25')}
        >
          {part}
        </mark>
      )
    })
  }

  return (
    <div ref={containerRef} className="space-y-5">
      {segments.map((seg, index) => {
        // Missing audio, shown honestly: a labelled break rather than a
        // seamless join between two moments that may be minutes apart.
        if (seg.kind === 'gap') {
          return (
            <div key={index} className="flex items-center gap-3" aria-label="Missing audio">
              <span className="h-px flex-1 bg-line-soft" />
              <span className="text-xs font-medium uppercase tracking-wide text-faint tabular-nums">
                {seg.text}
              </span>
              <span className="h-px flex-1 bg-line-soft" />
            </div>
          )
        }
        const style = speakerStyle(seg.speaker, repSpeaker, speakerCount)
        return (
          <div key={index}>
            <div className="mb-1 flex items-center gap-2">
              <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
              <span className={cn('text-xs font-semibold uppercase tracking-wide', style.label)}>
                {speakerLabel(seg.speaker, repSpeaker, speakerCount)}
              </span>
            </div>
            <p className="text-[17px] leading-[1.7] text-ink">{renderText(seg.text)}</p>
          </div>
        )
      })}
      {interimText ? <p className="text-[17px] leading-[1.7] text-faint">{interimText}</p> : null}
    </div>
  )
}
