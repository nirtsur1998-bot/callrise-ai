import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@renderer/lib/cn'
import type { DealStageKind } from './types'

/**
 * "You just closed this — what made the difference?"
 *
 * ── WHY IT IS A BANNER AND NOT A DIALOG ──────────────────────────────────
 *
 * The founder's constraint: *optional, skippable in one action, never
 * blocking.* A modal fails all three at once — it takes over the screen, it
 * has to be dismissed before anything else can happen, and dismissing it is
 * the same gesture as cancelling, so "no thanks" and "oops" become
 * indistinguishable. This appears in the page, leaves the board usable
 * underneath, and can simply be ignored.
 *
 * ── WHY IT ASKS ON WON DEALS TOO ─────────────────────────────────────────
 *
 * Asking only on losses would build a detailed record of what goes wrong and
 * nothing about what goes right — a one-armed sample, the exact failure the
 * gate exists to refuse, arriving through the back door of the UI instead of
 * through the analysis. The question is phrased differently per outcome
 * because "what went wrong?" is the wrong question for a win, but it is asked
 * either way.
 *
 * ── WHY THERE IS NO REQUIRED FIELD AND NO VALIDATION ─────────────────────
 *
 * A forced reason is a made-up reason. A made-up reason is worse than a blank
 * one, because later it reads as evidence and nothing distinguishes it from a
 * real one. Empty is a legitimate final state.
 */

interface OutcomeReasonPromptProps {
  dealTitle: string
  kind: Exclude<DealStageKind, 'open'>
  stageLabel: string
  onSave: (reason: string) => void
  onSkip: () => void
}

const QUESTION: Record<Exclude<DealStageKind, 'open'>, string> = {
  won: 'What do you think won it?',
  lost: 'What do you think lost it?',
  'went-quiet': 'Any idea where it went quiet?'
}

const PLACEHOLDER: Record<Exclude<DealStageKind, 'open'>, string> = {
  won: 'e.g. got the technical lead on the second call',
  lost: 'e.g. price, and they had budget approved elsewhere',
  'went-quiet': 'e.g. champion left, nobody picked it up'
}

export function OutcomeReasonPrompt({
  dealTitle,
  kind,
  stageLabel,
  onSave,
  onSkip
}: OutcomeReasonPromptProps): React.JSX.Element {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus the field, but do NOT trap focus and do not scroll the page. The
  // board underneath stays fully usable; this is an offer, not a step.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true })
  }, [])

  const save = (): void => {
    const trimmed = text.trim()
    // An empty save is a skip. Saving a blank string would record "there was
    // no reason" — which is a different claim from "not answered", and the
    // one the analysis must never be handed.
    if (!trimmed) onSkip()
    else onSave(trimmed)
  }

  return (
    <div
      className="mb-4 rounded-xl border border-line-soft bg-surface px-4 py-3"
      role="region"
      aria-label="Record why this deal closed"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 shrink-0">
          <p className="text-[13px] text-ink">
            <span className="font-medium">{dealTitle}</span>{' '}
            <span className="text-muted">
              moved to {stageLabel}. {QUESTION[kind]}
            </span>
          </p>
        </div>
        <div className="flex min-w-[16rem] flex-1 items-center gap-2">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              // Escape skips — the same single action as the ✕, because the
              // fastest way out must not be the one that leaves it hanging.
              if (e.key === 'Escape') onSkip()
            }}
            placeholder={PLACEHOLDER[kind]}
            maxLength={500}
            className={cn(
              'h-8 flex-1 rounded-md border border-line bg-elevated px-2.5 text-[13px] text-ink',
              'placeholder:text-faint focus:border-line-strong focus:outline-none'
            )}
          />
          <button
            type="button"
            onClick={save}
            className="h-8 shrink-0 rounded-md bg-accent-soft px-3 text-[12px] font-medium text-ink transition-colors hover:bg-elevated"
          >
            Save
          </button>
          <button
            type="button"
            onClick={onSkip}
            aria-label="Skip — don't record a reason"
            title="Skip — don't record a reason"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-faint transition-colors hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <p className="mt-1.5 text-[11px] text-faint">
        Optional, and skipping is fine — a guessed reason is worse than a blank one.
      </p>
    </div>
  )
}

/** Shown once, in place of the prompt, after it has been skipped repeatedly.
 *  The app saying it has noticed — rather than either nagging or going
 *  silently, unexplainedly missing. */
export function OutcomeReasonRetiredNotice({
  onDismiss
}: {
  onDismiss: () => void
}): React.JSX.Element {
  return (
    <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-line-soft bg-surface px-4 py-3">
      <p className="text-[13px] leading-relaxed text-muted">
        You&apos;ve skipped that a few times, so I&apos;ll stop asking. You can still add a reason
        to any deal from its detail page whenever you want to.
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:text-ink"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
