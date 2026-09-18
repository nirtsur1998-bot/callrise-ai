import { useEffect, useRef, useState } from 'react'
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

/** How long the outgoing cue's ghost stays mounted — the length of
 *  `--motion-cue-out` in index.css. A timer, not `animationend`: the test
 *  DOM runs no animations, and a ghost that waits for an event that never
 *  fires is a ghost that never leaves. */
const EXIT_MS = 160

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * M36 Stage 2 — THE GLANCE LINE. One cue at a time, at most a short sentence,
 * with the evidence it was made from in smaller type beside it. Top of the
 * window, full width; nothing else on the screen animates. Space (while the
 * line is up) or a click marks the cue useful — the absorption instrument.
 * A cue whose evidence is blank does not render at all — and (BUG-282) neither
 * does a cue whose SENTENCE is blank: seen once on the sandbox after a call
 * ended, the line showed the label, the mono evidence and the Useful button
 * with nothing between them. Evidence with no claim is not a cue either.
 *
 * INSTRUMENT PANEL: the line owns a 44px slot that is ALWAYS mounted. Before
 * this it returned null between cues, so every arrival and every expiry
 * pushed "Hide transcript" and the transcript itself down and back up — the
 * one screen where nothing is supposed to move, moving twice per cue. The
 * slot is the fixed thing; the cue is what appears inside it. The
 * `glance-line` test id stays on the cue, not the slot, so "absent when
 * there is no cue" remains exactly the claim it was.
 */
/** The one render gate: evidence AND a sentence, or the slot stays empty.
 *  Both the 'shown' record and the paint go through this, so a cue that is
 *  not drawn is never counted as seen. */
export function isRenderableCue(cue: GlanceCue | null): cue is GlanceCue {
  return !!cue && hasEvidence(cue.evidence) && cue.text.trim().length > 0
}

export function GlanceLine({
  cue,
  onDismiss
}: {
  cue: GlanceCue | null
  onDismiss: (id: number) => void
}): React.JSX.Element {
  const shownRef = useRef<number | null>(null)
  const markedRef = useRef<Set<number>>(new Set())
  // The cue that just left, kept for the exit fade only. Never clickable,
  // never announced, never carries the test id — it is paint, not a cue.
  const [ghost, setGhost] = useState<GlanceCue | null>(null)
  const [prevLive, setPrevLive] = useState<GlanceCue | null>(null)

  // record 'shown' once per cue id, never for a cue that is not drawn
  useEffect(() => {
    if (!isRenderableCue(cue)) return
    if (shownRef.current === cue.id) return
    shownRef.current = cue.id
    recordAbsorption({ type: 'shown', cueId: cue.id, kind: cue.kind, at: Date.now() })
  }, [cue])

  useEffect(() => {
    if (!cue) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      )
        return
      e.preventDefault()
      markUseful()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const live = isRenderableCue(cue) ? cue : null

  // Exit: when the live cue goes away (expiry or dismiss), keep a ghost of it
  // for the fade. A REPLACEMENT never ghosts — one cue at a time means the
  // new one simply takes the slot. Reduced motion skips the ghost entirely.
  // State is adjusted DURING render (React's "storing information from
  // previous renders" pattern), not in an effect: the ghost must exist on
  // the same frame the cue leaves, or the slot flashes empty first.
  if ((live?.id ?? null) !== (prevLive?.id ?? null)) {
    setPrevLive(live)
    setGhost(!live && prevLive && !prefersReducedMotion() ? prevLive : null)
  }
  useEffect(() => {
    if (!ghost) return
    const t = setTimeout(() => setGhost(null), EXIT_MS)
    return () => clearTimeout(t)
  }, [ghost])

  function markUseful(): void {
    if (!cue || markedRef.current.has(cue.id)) return
    markedRef.current.add(cue.id)
    recordAbsorption({ type: 'useful', cueId: cue.id, kind: cue.kind }) // stamped by the ledger, not by render
  }

  const shown = live ?? ghost
  const isGhost = !live && ghost !== null
  const marked = live !== null && markedRef.current.has(live.id)
  const evidenceText = shown
    ? shown.evidence.kind === 'heard'
      ? `heard: "${trimQuote(shown.evidence.quote)}"`
      : shown.evidence.label
    : ''

  return (
    <div
      data-testid="glance-slot"
      role="status"
      aria-live="polite"
      className="no-drag flex min-h-11 w-full items-stretch"
    >
      {!shown ? (
        // The empty state is a hairline and one faint word, hidden from the
        // live region so a cue's departure is not announced as "listening".
        <div
          aria-hidden="true"
          className="flex min-h-11 w-full items-center border-l border-line-soft pl-3 text-2xs text-faint"
        >
          listening
        </div>
      ) : (
        <div
          key={shown.id}
          data-testid={isGhost ? undefined : 'glance-line'}
          aria-hidden={isGhost || undefined}
          onClick={isGhost ? undefined : markUseful}
          className={cn(
            'flex min-h-11 w-full cursor-pointer items-center gap-3 border-l-[3px] pr-1 pl-3',
            shown.source === 'heard' ? 'border-l-accent' : 'border-l-line-strong',
            isGhost ? 'glance-out pointer-events-none' : 'glance-in'
          )}
        >
          <span
            className={cn(
              'shrink-0 text-2xs font-semibold tracking-wide uppercase',
              shown.source === 'heard' ? 'text-accent' : 'text-muted'
            )}
          >
            {shown.source === 'heard' ? 'now' : 'suggestion'}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={shown.text}>
            {shown.text}
          </span>
          <span
            // `min-w-0 max-w-[40%]` and NOT `shrink-0`: the evidence may
            // ellipsize, the sentence keeps priority; with `shrink-0` a long
            // quote ran past the row's right edge (founder's screenshot).
            className="hidden min-w-0 max-w-[40%] truncate font-mono text-2xs text-muted sm:inline"
            data-testid={isGhost ? undefined : 'glance-evidence'}
          >
            {evidenceText}
          </span>
          {/* The absorption control, as a control: a ghost button with the
              key that also presses it. Clicking it reaches markUseful exactly
              once — stopPropagation keeps the click-anywhere handler on the
              row from seeing the same click a second time. */}
          <button
            type="button"
            tabIndex={-1}
            disabled={isGhost}
            onClick={(e) => {
              e.stopPropagation()
              markUseful()
            }}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-2xs font-medium',
              marked
                ? 'border-positive/50 text-positive'
                : 'border-line text-muted hover:border-line-strong hover:text-ink'
            )}
          >
            {marked ? (
              'Useful ✓'
            ) : (
              <>
                Useful
                <kbd className="rounded border border-line bg-canvas px-1 font-mono text-[10px] leading-4 text-faint">
                  space
                </kbd>
              </>
            )}
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            disabled={isGhost}
            className="shrink-0 rounded p-1 text-faint hover:text-ink"
            onClick={(e) => {
              e.stopPropagation()
              if (!cue) return
              recordAbsorption({ type: 'dismissed', cueId: cue.id, kind: cue.kind, at: Date.now() })
              onDismiss(cue.id)
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
