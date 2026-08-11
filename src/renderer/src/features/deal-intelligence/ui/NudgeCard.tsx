import { useEffect, useState } from 'react'
import { Check, ChevronDown, Quote, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import { IconButton } from '@renderer/components/IconButton'
import { CollapseTransition } from './CollapseTransition'
import { ConfidenceMeter } from './ConfidenceMeter'
import { formatRelativeTime, formatSubtype, NUDGE_META } from './meta'
import type { Nudge } from './types'

const ROLE_LABEL: Record<Nudge['evidenceRole'], string> = {
  rep: 'You said',
  other: 'They said'
}

interface NudgeCardProps {
  nudge: Nudge
  nowMs: number
  /** Only the freshest nudge (index 0) gets its evidence receipt permanently
   *  expanded and the full-strength ring. Evidence-transparency is a hard
   *  requirement, but three simultaneously-expanded quote blocks is real
   *  reading, not glancing, on the one nudge a rep is actually deciding on
   *  right now — older, receding nudges keep a one-line evidence preview and
   *  a click away from the same full receipt, never zero access to it. */
  isNewest: boolean
  /** Whether feedback was already given — governs thumbs vs. confirmation. */
  rated: boolean
  onDismiss: () => void
  onFeedback?: (helpful: boolean) => void
}

/**
 * One nudge, rendered as a small evidence brief rather than a toast: a
 * one-line verdict up top, the receipt (the actual transcript quote)
 * inline underneath. A rep mid-call will not act on "the AI thinks there's
 * a risk," only on "the AI thinks there's a risk BECAUSE the prospect said
 * this" — so for the nudge that matters right now, the quote is never
 * behind a click.
 */
export function NudgeCard({
  nudge,
  nowMs,
  isNewest,
  rated,
  onDismiss,
  onFeedback
}: NudgeCardProps): React.JSX.Element {
  const meta = NUDGE_META[nudge.type]
  const Icon = meta.icon

  // Same enter transition CueCard already uses for the interrupt-tier cue:
  // mount translated/transparent, flip to settled on the next frame. A new
  // nudge should register as "something just arrived" using motion the rep
  // has already learned means that, not a bespoke arrival flourish.
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Dismiss is two-phase, driven by CollapseTransition below: clicking the
  // X sets `closing`, which fades the card and starts its grid-rows collapse
  // to zero height; the real onDismiss (which the panel uses to actually
  // shrink the `nudges` array) only fires from CollapseTransition's
  // `onTransitionEnd`, not from this click handler. That ordering is the
  // whole point — the card can't visually vanish out from under its own
  // exit animation just because the parent re-rendered first.
  const [closing, setClosing] = useState(false)

  // Evidence on non-newest cards is collapsed by default — see isNewest doc
  // above — but still one click away, never hidden behind a separate screen.
  const [evidenceOpen, setEvidenceOpen] = useState(isNewest)

  return (
    <CollapseTransition open={!closing} onCollapsed={onDismiss}>
      <div
        className={cn(
          'glass-hud pointer-events-auto relative overflow-hidden rounded-2xl p-3 ring-1 ring-inset transition-[opacity,transform] duration-300',
          isNewest ? meta.ring : 'ring-line-soft',
          !isNewest && 'opacity-90 hover:opacity-100',
          closing ? 'opacity-0' : shown ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
        )}
      >
        <span className="glass-sheen rounded-2xl" />

        <div className="flex items-start gap-2.5">
          <div className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg', meta.badgeBg)}>
            <Icon className={cn('h-3.5 w-3.5', meta.text)} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className={cn('text-[10px] font-semibold tracking-wide uppercase', meta.text)}>
                {meta.label}
              </span>
              <span className="truncate text-[11px] font-medium text-muted">
                {formatSubtype(nudge.subtype)}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-snug font-semibold text-ink">
              {nudge.suggestedCue}
            </p>
          </div>

          <IconButton
            icon={X}
            onClick={() => setClosing(true)}
            label="Dismiss nudge"
            className="h-6 w-6"
          />
        </div>

        {isNewest ? (
          // The evidence block for the newest nudge is structurally
          // un-collapsible — no expand/reveal affordance at all. Making this
          // a click-to-reveal accordion would be the "safe" compact choice,
          // but it reads as confidence FROM the product ("trust us") rather
          // than confidence the rep can actually verify, on the one exact
          // nudge the brief's evidence-transparency requirement exists for.
          <EvidenceBlock nudge={nudge} border={meta.border} />
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEvidenceOpen((v) => !v)}
              aria-expanded={evidenceOpen}
              aria-controls={`di-evidence-${nudge.id}`}
              className="mt-1.5 flex w-full items-center gap-1.5 rounded-lg px-0.5 py-0.5 text-left transition hover:text-ink"
            >
              <Quote className="h-3 w-3 shrink-0 text-faint" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint italic">
                &ldquo;{nudge.evidenceQuote}&rdquo;
              </span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'h-3 w-3 shrink-0 text-faint transition-transform duration-200',
                  evidenceOpen && 'rotate-180'
                )}
              />
            </button>
            <CollapseTransition open={evidenceOpen}>
              <div id={`di-evidence-${nudge.id}`} className="pt-1.5">
                <EvidenceBlock nudge={nudge} border={meta.border} />
              </div>
            </CollapseTransition>
          </>
        )}

        <div className="mt-2 flex items-center justify-between gap-2">
          <ConfidenceMeter confidence={nudge.confidence} fillClassName={meta.fill} />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-faint">
              {formatRelativeTime(nudge.createdAtMs, nowMs)}
            </span>
            {onFeedback &&
              (rated ? (
                <span
                  className="flex items-center gap-1 text-[10px] text-faint"
                  title="Thanks — this tunes future calls"
                >
                  <Check className="h-3 w-3" aria-hidden="true" />
                  Noted
                </span>
              ) : (
                <div className="flex items-center gap-0.5">
                  <IconButton
                    icon={ThumbsUp}
                    label="Mark this nudge helpful"
                    onClick={() => onFeedback(true)}
                    className="h-6 w-6 hover:text-positive"
                  />
                  <IconButton
                    icon={ThumbsDown}
                    label="Mark this nudge not helpful"
                    onClick={() => onFeedback(false)}
                    className="h-6 w-6 hover:text-danger"
                  />
                </div>
              ))}
          </div>
        </div>
      </div>
    </CollapseTransition>
  )
}

/** The receipt itself — a left-border quote block with a `Quote` glyph and a
 *  role label, factored out so the newest card (always rendered) and older
 *  cards (rendered inside their own collapse) draw the exact same markup. */
function EvidenceBlock({ nudge, border }: { nudge: Nudge; border: string }): React.JSX.Element {
  return (
    <div className={cn('flex gap-2 rounded-lg border-l-2 bg-canvas/40 py-1.5 pr-2 pl-2.5', border)}>
      <Quote className="mt-0.5 h-3 w-3 shrink-0 text-faint" aria-hidden="true" />
      <div className="min-w-0">
        <span className="text-[9px] font-semibold tracking-wide text-faint uppercase">
          {ROLE_LABEL[nudge.evidenceRole]}
        </span>
        <p className="text-[12.5px] leading-snug text-muted italic">
          &ldquo;{nudge.evidenceQuote}&rdquo;
        </p>
      </div>
    </div>
  )
}
