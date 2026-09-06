import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { hasEvidence, recordAbsorption, trimQuote, type CueEvidence } from './hudCore'

export interface GlanceCue {
  id: number
  kind: string
  text: string
  /** Required at the type level and checked at render: no evidence, no line. */
  evidence: CueEvidence
  /** 'heard' cues are deterministic; 'suggestion' cues came from a model and
   *  say so — the two vocabularies are never mixed. */
  source: 'heard' | 'suggestion'
}

/**
 * M36 Stage 2 — THE GLANCE LINE. One cue at a time, at most a short sentence,
 * with the evidence it was made from in smaller type beside it. Top of the
 * window, full width; nothing else on the screen animates. Space (while the
 * line is up) or a click marks the cue useful — the absorption instrument.
 * A cue whose evidence is blank does not render at all.
 */
export function GlanceLine({
  cue,
  onDismiss
}: {
  cue: GlanceCue | null
  onDismiss: (id: number) => void
}): React.JSX.Element | null {
  const shownRef = useRef<number | null>(null)
  const markedRef = useRef<Set<number>>(new Set())

  // record 'shown' once per cue id, never for a cue without evidence
  useEffect(() => {
    if (!cue || !hasEvidence(cue.evidence)) return
    if (shownRef.current === cue.id) return
    shownRef.current = cue.id
    recordAbsorption({ type: 'shown', cueId: cue.id, kind: cue.kind, at: Date.now() })
  }, [cue])

  useEffect(() => {
    if (!cue) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      e.preventDefault()
      markUseful()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!cue || !hasEvidence(cue.evidence)) return null

  function markUseful(): void {
    if (!cue || markedRef.current.has(cue.id)) return
    markedRef.current.add(cue.id)
    recordAbsorption({ type: 'useful', cueId: cue.id, kind: cue.kind, at: Date.now() })
  }

  const marked = markedRef.current.has(cue.id)
  const evidenceText =
    cue.evidence.kind === 'heard' ? `heard: "${trimQuote(cue.evidence.quote)}"` : cue.evidence.label

  return (
    <div
      data-testid="glance-line"
      role="status"
      aria-live="polite"
      onClick={markUseful}
      className={cn(
        'no-drag flex w-full cursor-pointer items-center gap-3 rounded-xl border px-4 py-2.5',
        cue.source === 'heard' ? 'border-accent/40 bg-accent-soft' : 'border-line bg-elevated',
        marked && 'ring-1 ring-positive/50'
      )}
    >
      <span className={cn('shrink-0 text-[11px] font-semibold uppercase tracking-wide', cue.source === 'heard' ? 'text-accent' : 'text-muted')}>
        {cue.source === 'heard' ? 'now' : 'suggestion'}
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink" title={cue.text}>
        {cue.text}
      </span>
      <span className="hidden shrink-0 text-[11px] text-muted sm:inline" data-testid="glance-evidence">
        {evidenceText}
      </span>
      <span className="shrink-0 text-[11px] text-faint">{marked ? 'useful ✓' : 'space = useful'}</span>
      <button
        type="button"
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-faint hover:text-ink"
        onClick={(e) => {
          e.stopPropagation()
          recordAbsorption({ type: 'dismissed', cueId: cue.id, kind: cue.kind, at: Date.now() })
          onDismiss(cue.id)
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
