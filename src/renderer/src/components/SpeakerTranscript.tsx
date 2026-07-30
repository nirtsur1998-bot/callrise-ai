import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { CallSegment } from '@renderer/features/calls/types'
import {
  speakerLabel,
  speakerIdentityFor,
  SPEAKER_SOURCE_LABEL,
  type SpeakerIdentities
} from '@renderer/features/coaching/meta'
import { speakerKey } from '@renderer/features/live/segments'

const CONFIDENCE_DOT: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-positive',
  medium: 'bg-warning',
  low: 'bg-faint'
}

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
  /** M19 Task 2 — resolved real names, keyed by speakerKey(). When a segment
   *  has a resolved identity, its name replaces You/Buyer/Speaker N and a
   *  confidence dot appears next to it (hover shows the source). */
  identities?: SpeakerIdentities
  /** Enables one-click inline rename (a name click becomes an editable
   *  field). Omit for read-only surfaces (live view, the "peek" modal,
   *  practice mode) where an accidental rename mid-flow would be surprising. */
  onRename?: (key: string, name: string) => void
}

/** Renders a transcript grouped into speaker turns. Shared by the Live view
 *  and the saved-call detail view. */
export function SpeakerTranscript({
  segments,
  interimText,
  repSpeaker = null,
  highlightQuery,
  activeMatchIndex,
  identities,
  onRename
}: SpeakerTranscriptProps): React.JSX.Element {
  // Keyed by segment INDEX, not speakerKey(seg) — speakerKey is shared by
  // every turn a speaker takes (mergeSegments only merges consecutive runs),
  // so keying open/closed state by it would open an <input autoFocus> on
  // EVERY segment from that speaker at once the moment any one of them is
  // clicked, each stealing focus from the last and immediately blurring
  // (committing/closing) the others. The index is unique per segment; the
  // identity actually being renamed is still resolved via speakerKey(seg) in
  // commitEdit below.
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
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
        const key = speakerKey(seg)
        const identity = speakerIdentityFor(seg.speaker, identities, seg.channel)
        const label = speakerLabel(seg.speaker, repSpeaker, speakerCount, identities, seg.channel)
        const isEditing = editingIndex === index

        const startEdit = (): void => {
          if (!onRename) return
          setEditValue(identity?.name ?? '')
          setEditingIndex(index)
        }
        const commitEdit = (): void => {
          const trimmed = editValue.trim()
          if (trimmed && onRename) onRename(key, trimmed)
          setEditingIndex(null)
        }

        return (
          <div key={index}>
            <div className="mb-1 flex items-center gap-2">
              <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
              {isEditing ? (
                <input
                  autoFocus
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    if (e.key === 'Escape') setEditingIndex(null)
                  }}
                  className="rounded border border-line bg-canvas px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-ink outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={startEdit}
                  disabled={!onRename}
                  className={cn(
                    'group flex items-center gap-1 text-xs font-semibold uppercase tracking-wide',
                    style.label,
                    onRename && 'cursor-pointer hover:underline'
                  )}
                  title={onRename ? 'Click to rename' : undefined}
                >
                  {label}
                  {onRename && (
                    <Pencil className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover:opacity-60" />
                  )}
                </button>
              )}
              {identity && (
                <span
                  className={cn('h-1.5 w-1.5 rounded-full', CONFIDENCE_DOT[identity.confidence])}
                  title={SPEAKER_SOURCE_LABEL[identity.source]}
                />
              )}
            </div>
            <p className="text-[17px] leading-[1.7] text-ink">{renderText(seg.text)}</p>
          </div>
        )
      })}
      {interimText ? <p className="text-[17px] leading-[1.7] text-faint">{interimText}</p> : null}
    </div>
  )
}
