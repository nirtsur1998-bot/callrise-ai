import { Tooltip } from './Tooltip'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { CallSegment, SpeakerRole } from '@renderer/features/calls/types'
import {
  speakerLabel,
  speakerIdentityFor,
  SPEAKER_SOURCE_LABEL,
  type SpeakerIdentities
} from '@renderer/features/coaching/meta'
import { speakerKey } from '@renderer/features/live/speakerKey'

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
  speakerCount: number,
  role?: SpeakerRole
): { dot: string; label: string } {
  // The turn's own recorded attribution wins when it has one (M21).
  if (role === 'rep') return REP_STYLE
  if (role === 'other' && speakerCount <= 2) return BUYER_STYLE
  if (role === undefined && repSpeaker !== null && speakerCount <= 2) {
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

/** Highlights `query` inside `text`, numbering marks starting at `startIndex`
 *  (the count of matches already rendered by earlier segments) so a match's
 *  index stays correct even though each segment now renders independently —
 *  see the comment on `matchOffsets` below for why that split is safe. */
function renderHighlighted(
  text: string,
  query: string,
  startIndex: number,
  activeMatchIndex: number | undefined
): React.ReactNode {
  if (!query) return text
  const re = new RegExp(`(${escapeRegExp(query)})`, 'gi')
  const parts = text.split(re)
  if (parts.length === 1) return text
  let counter = startIndex
  return parts.map((part, i) => {
    // `split` with a capturing group interleaves [text, match, text, match, …] —
    // odd indices are the captured matches.
    if (i % 2 === 0 || part === '') return part || null
    const idx = counter++
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

interface SegmentRowProps {
  seg: CallSegment
  index: number
  repSpeaker: number | null
  speakerCount: number
  identities?: SpeakerIdentities
  query: string
  matchOffset: number
  activeMatchIndex?: number
  onRename?: (key: string, name: string) => void
  isEditing: boolean
  editValue: string
  onStartEdit: (index: number, initialValue: string) => void
  onEditValueChange: (value: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
}

/**
 * One turn (or one gap marker). Memoized so an interim-only update, or a
 * finalized message that only touches the LATEST turn, does not force React
 * to re-render and re-diff every earlier turn in the transcript — on a long
 * call that full-list re-render was growing more expensive turn by turn (see
 * segments.ts's mergeSegments, which now preserves object identity for every
 * turn this component didn't touch, making this memoization actually work).
 */
const SegmentRow = memo(function SegmentRow({
  seg,
  index,
  repSpeaker,
  speakerCount,
  identities,
  query,
  matchOffset,
  activeMatchIndex,
  onRename,
  isEditing,
  editValue,
  onStartEdit,
  onEditValueChange,
  onCommitEdit,
  onCancelEdit
}: SegmentRowProps): React.JSX.Element {
  if (seg.kind === 'gap') {
    return (
      <div className="flex items-center gap-3" aria-label="Missing audio">
        <span className="h-px flex-1 bg-line-soft" />
        <span className="text-xs font-medium uppercase tracking-wide text-faint tabular-nums">
          {seg.text}
        </span>
        <span className="h-px flex-1 bg-line-soft" />
      </div>
    )
  }

  const style = speakerStyle(seg.speaker, repSpeaker, speakerCount, seg.role)
  const identity = speakerIdentityFor(seg.speaker, identities, seg.channel)
  const label = speakerLabel(
    seg.speaker,
    repSpeaker,
    speakerCount,
    seg.role,
    identities,
    seg.channel
  )

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
        {isEditing ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => onEditValueChange(e.target.value)}
            onBlur={onCommitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCommitEdit()
              if (e.key === 'Escape') onCancelEdit()
            }}
            className="rounded border border-line bg-canvas px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-ink outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => onStartEdit(index, identity?.name ?? '')}
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
        {!identity && seg.role === 'unknown' && (
          <Tooltip content="We could not tell who was speaking here, so this turn is not attributed to anyone.">
            <span className="text-[10px] font-medium uppercase tracking-wide text-faint">unsure</span>
          </Tooltip>
        )}
      </div>
      <p className="text-[17px] leading-[1.7] text-ink">
        {renderHighlighted(seg.text, query, matchOffset, activeMatchIndex)}
      </p>
    </div>
  )
})

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

  // How many matches appear in every EARLIER segment, per segment — computed
  // once per (segments, query) pass rather than via a mutable counter shared
  // across per-segment renders, because each segment now renders through an
  // independently memoized component and can't share mutable render state
  // with its siblings. Bails out to an all-zero lookup immediately when
  // there's no query (the live-call path, which never sets one), so this
  // costs nothing there.
  const matchOffsets = useMemo(() => {
    if (!query) return null
    const re = new RegExp(escapeRegExp(query), 'gi')
    const offsets: number[] = []
    let count = 0
    for (const seg of segments) {
      offsets.push(count)
      if (seg.kind !== 'gap') {
        const matches = seg.text.match(re)
        if (matches) count += matches.length
      }
    }
    return offsets
  }, [segments, query])

  // Latest-value refs for the three stable callbacks below. The callbacks
  // must keep one identity across renders (they're a prop on every memoized
  // SegmentRow, and a new identity on every render would invalidate every
  // row's memo on every message, exactly what this whole restructure exists
  // to avoid) — but they still need this render's segments/onRename/editValue
  // when they actually fire, which a useCallback dependency array can't give
  // them without also changing identity every time those change.
  const segmentsRef = useRef(segments)
  const onRenameRef = useRef(onRename)
  const editValueRef = useRef('')
  // Synced in an effect, not during render: render can run speculatively
  // (Strict Mode double-invoke, concurrent rendering) and a mid-render ref
  // write would leak a value from a render that never actually committed.
  // An effect only runs after a render commits, and always before the next
  // user-triggered event (click/keydown) that would read these refs.
  useEffect(() => {
    segmentsRef.current = segments
  }, [segments])
  useEffect(() => {
    onRenameRef.current = onRename
  }, [onRename])

  const startEdit = useCallback((index: number, initialValue: string) => {
    editValueRef.current = initialValue
    setEditValue(initialValue)
    setEditingIndex(index)
  }, [])
  const onEditValueChange = useCallback((value: string) => {
    editValueRef.current = value
    setEditValue(value)
  }, [])
  const cancelEdit = useCallback(() => setEditingIndex(null), [])
  const commitEdit = useCallback(() => {
    setEditingIndex((index) => {
      if (index === null) return null
      const seg = segmentsRef.current[index]
      const trimmed = editValueRef.current.trim()
      if (trimmed && onRenameRef.current && seg) onRenameRef.current(speakerKey(seg), trimmed)
      return null
    })
  }, [])

  return (
    <div ref={containerRef} className="space-y-5">
      {segments.map((seg, index) => (
        <SegmentRow
          key={index}
          seg={seg}
          index={index}
          repSpeaker={repSpeaker}
          speakerCount={speakerCount}
          identities={identities}
          query={query}
          matchOffset={matchOffsets ? matchOffsets[index] : 0}
          activeMatchIndex={activeMatchIndex}
          onRename={onRename}
          isEditing={editingIndex === index}
          editValue={editingIndex === index ? editValue : ''}
          onStartEdit={startEdit}
          onEditValueChange={onEditValueChange}
          onCommitEdit={commitEdit}
          onCancelEdit={cancelEdit}
        />
      ))}
      {interimText ? <p className="text-[17px] leading-[1.7] text-faint">{interimText}</p> : null}
    </div>
  )
}
