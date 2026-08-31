import { useCallback, useEffect, useRef, useState } from 'react'
import { X, Check, AlertTriangle } from 'lucide-react'
import { Modal } from '@renderer/components/Modal'
import { Button } from '@renderer/components/Button'
import { cn } from '@renderer/lib/cn'
import type { BackfillAnswer, BackfillRow, BackfillState } from './types'

/**
 * THE BACKFILL — one sitting, nineteen rows.
 *
 * ══ DESIGNED FOR THE TENTH ROW, NOT THE FIRST ═══════════════════════════
 *
 * The founder's constraint, verbatim: *"I'll be doing 19 rows in one sitting,
 * so the second row matters more than the first. Whatever friction exists gets
 * multiplied by nineteen — if a row takes three clicks instead of one, that's
 * the difference between finishing and abandoning at row seven."*
 *
 * Every layout decision below is downstream of that, and each one is a thing
 * the obvious implementation gets wrong:
 *
 *  1. ONE CLICK PER ROW. The answer buttons are on the row itself. No
 *     dropdown (two clicks), no dialog (three plus a dismiss), no save step.
 *  2. THE BUTTONS NEVER MOVE AND NEVER DISAPPEAR. An answered row keeps all
 *     five buttons exactly where they were, with the chosen one filled in.
 *     Changing an answer is therefore also one click. The tempting version —
 *     collapse the answered row to a summary with a "Change" link — costs two
 *     extra clicks precisely when the founder has just realised they
 *     misclicked.
 *  3. NOTHING REORDERS. Answered rows do not sort to the bottom and are not
 *     removed. If they moved, the row under the cursor would change after
 *     every single click, nineteen times, and row ten would never be where
 *     row ten was a second ago.
 *  4. THE ROW CARRIES ENOUGH TO ANSWER IT. Name, company, how many coached
 *     calls, when the last one was, what it was called. Having to open a call
 *     to remember who someone was is a round trip; nineteen round trips is
 *     the abandonment.
 *  5. CLICKING THE SAME ANSWER AGAIN IS A NO-OP, NOT A TOGGLE. A double-click
 *     must not silently un-answer a row. Clearing is a separate, deliberate ✕.
 *  6. NOTHING BLOCKS. Writes are optimistic and the buttons stay live, so row
 *     eleven is clickable while row ten is still saving. A real failure
 *     surfaces on its own row rather than as a modal.
 *
 * ══ WHY THE WHOLE LIST IS VISIBLE UP FRONT ══════════════════════════════
 *
 * Not for convenience — for validity. Asking one at a time, whenever the app
 * feels like it, produces a sample of the deals that were MEMORABLE, and
 * memorability correlates with how they ended. Showing all of them at once,
 * with a visible denominator, is what makes answering row 14 as likely as
 * answering row 1. That is also why "I don't remember" is a first-class
 * button and not a skip: it records that the row was seen and could not be
 * answered, which is the only thing that can later tell the founder their own
 * backfill is not trustworthy.
 */

interface OutcomeBackfillDialogProps {
  onClose: () => void
  /** Called after any write, so the board's counter refreshes with the list. */
  onChanged?: () => void
}

const ANSWER_LABEL: Record<BackfillAnswer, string> = {
  won: 'Won',
  lost: 'Lost',
  'went-quiet': 'Went quiet',
  'dont-remember': "Don't remember",
  'not-a-deal': 'Not a deal'
}

/** Derived from the label map rather than hand-kept, so a sixth answer cannot
 *  be added to the union and silently fail to appear on every row. */
const ANSWER_ORDER = Object.keys(ANSWER_LABEL) as BackfillAnswer[]

const ANSWER_HINT: Record<BackfillAnswer, string> = {
  won: 'They bought.',
  lost: 'They said no.',
  'went-quiet': 'It faded out — no decision either way. Counted on its own, never as a loss.',
  'dont-remember': "A real answer. Better than a guess, and it keeps the rest trustworthy.",
  'not-a-deal': 'Never a pursuit — support, a colleague, a test call.'
}

const ANSWER_ACTIVE: Record<BackfillAnswer, string> = {
  won: 'border-positive bg-positive-soft text-positive',
  lost: 'border-danger bg-danger-soft text-danger',
  'went-quiet': 'border-line-strong bg-elevated text-ink',
  'dont-remember': 'border-line-strong bg-elevated text-muted',
  'not-a-deal': 'border-line-strong bg-elevated text-muted'
}

const ERROR_TEXT: Record<string, string> = {
  'no-stage-for-kind':
    'Your pipeline has no stage of that kind — add one under Stages and try again.',
  'unknown-contact': "That contact no longer exists, so there's nothing to record against it.",
  'deal-failed': "Couldn't create the deal for that answer. Nothing was recorded."
}

function formatDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function OutcomeBackfillDialog({
  onClose,
  onChanged
}: OutcomeBackfillDialogProps): React.JSX.Element {
  const [state, setState] = useState<BackfillState | null>(null)
  const [loading, setLoading] = useState(true)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  // Only the newest write's response is authoritative. Clicking row 10 while
  // row 9 is still in flight must not have row 9's older snapshot land on top
  // of row 10's answer — and row 10's response already contains row 9's.
  const seqRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const next = await window.api.dealBackfill.state()
    seqRef.current += 1
    setState(next)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const answer = async (contactId: string, value: BackfillAnswer): Promise<void> => {
    const current = state?.rows.find((r) => r.contactId === contactId)
    if (current?.answer === value) return // rule 5: idempotent, never a toggle

    const mySeq = ++seqRef.current
    // Optimistic: the row fills in on the click, not on the round trip.
    setState((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) => (r.contactId === contactId ? { ...r, answer: value } : r)),
            answered: prev.rows.filter((r) =>
              r.contactId === contactId ? true : Boolean(r.answer)
            ).length
          }
        : prev
    )
    setRowErrors((prev) => {
      const { [contactId]: _drop, ...rest } = prev
      return rest
    })

    const result = await window.api.dealBackfill.answer(contactId, value)
    onChanged?.()
    if (!result.ok) {
      // Failure surfaces ON THE ROW and the optimistic answer is rolled back,
      // because a row that looks answered but was not recorded is exactly the
      // gap this milestone exists to close.
      setRowErrors((prev) => ({
        ...prev,
        [contactId]: ERROR_TEXT[result.error ?? ''] ?? 'That answer could not be saved.'
      }))
      await load()
      return
    }
    if (mySeq !== seqRef.current) return // a newer click is already authoritative
    if (result.state) setState(result.state)
  }

  const clear = async (contactId: string): Promise<void> => {
    const mySeq = ++seqRef.current
    setState((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) =>
              r.contactId === contactId ? { ...r, answer: undefined, dealId: undefined } : r
            )
          }
        : prev
    )
    const result = await window.api.dealBackfill.clear(contactId)
    onChanged?.()
    if (mySeq !== seqRef.current) return
    if (result.state) setState(result.state)
  }

  const rows = state?.rows ?? []
  const answered = rows.filter((r) => r.answer).length
  const total = rows.length
  const pct = total > 0 ? Math.round((answered / total) * 100) : 0

  return (
    // ── BOUNDED HEIGHT, INTERNAL SCROLL ────────────────────────────────
    //
    // MEASURED IN THE RUNNING APP, not reasoned about: with 15 rows the panel
    // was 1261px tall in an 816px viewport, positioned at top:-223 — Modal
    // centres a flex item with `overflow-hidden` and no max-height, so it
    // overflowed in BOTH directions with nothing scrollable anywhere in the
    // ancestor chain. **Three of fifteen rows were physically unclickable.**
    //
    // The structural check that ran just before this measurement reported
    // "every row has all five answer buttons" — true, and about rows no user
    // could reach. A DOM assertion describes what is in the document, not what
    // is operable, and the two are only the same until a layout bug.
    //
    // So: cap the panel, and scroll the LIST rather than the dialog. That also
    // gives the tenth row what it needs — the progress bar stays pinned
    // instead of scrolling away, so "how far along am I?" never costs a scroll
    // up and back.
    <Modal
      onClose={onClose}
      title="Record past outcomes"
      size="2xl"
      className="flex max-h-[85vh] flex-col"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
        <p className="max-w-3xl text-[13px] leading-relaxed text-muted">
          Every contact you&apos;ve had a coached call with is listed below —{' '}
          <strong className="font-medium text-ink">all of them, not a selection</strong>. That is
          deliberate: answering only the ones that come to mind would record the memorable deals
          rather than the typical ones, and how a deal ended is exactly the sort of thing that makes
          it memorable.{' '}
          <strong className="font-medium text-ink">&ldquo;Don&apos;t remember&rdquo; is a real
          answer</strong>{' '}
          — a guess would be worse than a blank.
        </p>

        {/* Progress, pinned ABOVE the scroll region — not merely above the
            list in source order. Before the panel was capped this scrolled
            away with everything else, so at row ten "how far along am I?" cost
            a scroll up and a scroll back. Fifteen times. */}
        <div className="shrink-0 rounded-xl border border-line-soft bg-surface px-3.5 py-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-ink">
              {answered} of {total} answered
            </span>
            <span className="text-[12px] tabular-nums text-faint">{pct}%</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated">
            <div
              className="h-full rounded-full bg-accent transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-2 text-[12px] text-faint">
            Answers save as you go. You can close this at any point and pick it up later — nothing
            will remind you.
          </p>
        </div>

        {loading ? (
          <p className="px-1 py-8 text-center text-sm text-muted">Loading your call history…</p>
        ) : total === 0 ? (
          <p className="rounded-xl border border-line-soft bg-surface px-4 py-8 text-center text-sm text-muted">
            Nothing to record — every contact you&apos;ve had a coached call with already has a
            deal.
          </p>
        ) : (
          // -my-1 px-1: the scroll container clips focus rings at its edges
          // otherwise, so a keyboard user cannot see which button is focused
          // on the first and last visible rows.
          <ul className="-mx-1 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-1">
            {rows.map((row) => (
              <BackfillRowItem
                key={row.contactId}
                row={row}
                error={rowErrors[row.contactId]}
                onAnswer={(v) => void answer(row.contactId, v)}
                onClear={() => void clear(row.contactId)}
              />
            ))}
          </ul>
        )}

        {/* Stays visible at the bottom rather than living past fifteen rows
            of scroll — closing must never require scrolling to the end. */}
        <div className="flex shrink-0 justify-end border-t border-line-soft pt-3">
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function BackfillRowItem({
  row,
  error,
  onAnswer,
  onClear
}: {
  row: BackfillRow
  error?: string
  onAnswer: (value: BackfillAnswer) => void
  onClear: () => void
}): React.JSX.Element {
  const answered = Boolean(row.answer)
  return (
    <li
      className={cn(
        'rounded-lg border px-3 py-2.5 transition-colors',
        answered ? 'border-line-soft bg-elevated/40' : 'border-line-soft bg-surface'
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-[13rem] flex-1">
          <div className="flex items-center gap-1.5">
            {answered && <Check className="h-3.5 w-3.5 shrink-0 text-positive" />}
            <span className="truncate text-[13px] font-medium text-ink">{row.name}</span>
            {row.company && (
              <span className="truncate text-[12px] text-faint">· {row.company}</span>
            )}
          </div>
          {/* Truncates, and that is fine for the part that gets cut: the count
              and the date are the memory jogs and always survive, the call
              title is a bonus. Seen truncating to "Ben — …" in the rendered
              app, so the full text is on hover rather than lost. */}
          <p
            className="mt-0.5 truncate text-[12px] text-faint"
            title={row.lastCallTitle ?? undefined}
          >
            {row.callCount} coached call{row.callCount === 1 ? '' : 's'}
            {row.lastCallAt && ` · last ${formatDate(row.lastCallAt)}`}
            {row.lastCallTitle && ` · ${row.lastCallTitle}`}
          </p>
        </div>

        {/* All five, always, in the same place. See rules 2 and 5 above. */}
        <div className="flex flex-wrap items-center gap-1">
          {ANSWER_ORDER.map((value) => {
            const active = row.answer === value
            return (
              <button
                key={value}
                type="button"
                onClick={() => onAnswer(value)}
                title={ANSWER_HINT[value]}
                aria-pressed={active}
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors',
                  active
                    ? ANSWER_ACTIVE[value]
                    : 'border-line text-muted hover:border-line-strong hover:text-ink'
                )}
              >
                {ANSWER_LABEL[value]}
              </button>
            )
          })}
          <button
            type="button"
            onClick={onClear}
            disabled={!answered}
            title={answered ? 'Clear this answer' : undefined}
            aria-label="Clear this answer"
            className={cn(
              'grid h-6 w-6 place-items-center rounded-md transition-colors',
              answered ? 'text-faint hover:text-danger' : 'invisible'
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {row.dealId && (
        <p className="mt-1.5 text-[11px] text-faint">
          Created a deal and linked {row.callCount} call{row.callCount === 1 ? '' : 's'} to it.
        </p>
      )}
      {error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </li>
  )
}
