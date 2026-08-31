import { ClipboardList } from 'lucide-react'
import { Button } from '@renderer/components/Button'
import type { Insight } from './types'

interface OutcomeInsightCardProps {
  insight: Insight
  /** Backfill rows that still have no answer — the offer, not a nag. */
  unansweredRows: number
  onOpenBackfill: () => void
}

/**
 * THE COUNTER. What the Pipeline board says while outcome insights are not
 * running — which is right now, and will be for months.
 *
 * ── WHY IT STATES THE SHAPE INSTEAD OF COUNTING DOWN ─────────────────────
 *
 * The obvious copy is "4 more won deals and 8 more lost deals to go!". The
 * founder rejected that, and was right to: a countdown implies the number is
 * the point and that arriving at it is imminent and automatic. It is neither.
 * The requirement is stated in full, once, and the current position is stated
 * next to it. The reader can subtract if they want to.
 *
 * ── WHY "8 IN EACH, NOT 16 BETWEEN THEM" IS SPELLED OUT ──────────────────
 *
 * Because everyone reads "8 won and 8 lost" as a total of 16 and assumes a
 * 12-and-4 split counts. It does not — a 12-and-4 split is 4. This exact
 * misreading also slipped into the first version of the gate's own test,
 * which asserted the per-arm rule using numbers that a summed gate would have
 * passed. If it can fool the test, it can fool the reader.
 *
 * ── WHY THE COACHING-METRICS CLAUSE IS NOT A FOOTNOTE ────────────────────
 *
 * A closed deal with no linked coached call contributes nothing. Without that
 * clause the counter would appear to be counting deals, the founder would
 * record deals, and the number on screen would not move — with no way to see
 * why.
 */
export function OutcomeInsightCard({
  insight,
  unansweredRows,
  onOpenBackfill
}: OutcomeInsightCardProps): React.JSX.Element | null {
  // The 'ready' arm has no renderer yet — the analysis it gates does not
  // exist. Rendering nothing is the correct behaviour and not a stub: this
  // card's whole job is what to say while there is nothing to say.
  if (insight.status !== 'insufficient') return null

  const { usable, closed, needPerArm, bindingArm, backfillUntrustworthy } = insight

  // THE GAP THIS EXISTS TO EXPLAIN, found by rendering the card against real
  // data rather than by reading it. The founder's board showed four Won deals
  // and this card said "You have 0 won and 0 lost" — both numbers correct
  // (`usable` counts only deals with a linked, coached call), and together
  // completely misleading: "you have no deals" and "your deals have no
  // measurable calls" need opposite actions, and read identically.
  const unmeasured = closed.won + closed.lost - (usable.won + usable.lost)

  return (
    <div className="mb-4 rounded-xl border border-line-soft bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-ink">Outcome insights aren&apos;t running yet</h3>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">
            To say anything about what you do differently on the calls you win, this needs{' '}
            <strong className="font-medium text-ink">
              {needPerArm} won and {needPerArm} lost deals
            </strong>{' '}
            — {needPerArm} in each, not {needPerArm * 2} between them. Each one has to have at least
            one linked call carrying coaching metrics.
          </p>
          <p className="mt-2 text-[13px] text-muted">
            Countable right now:{' '}
            <span className="font-medium tabular-nums text-positive">{usable.won} won</span> and{' '}
            <span className="font-medium tabular-nums text-danger">{usable.lost} lost</span>
            {usable.wentQuiet > 0 && (
              <>
                {' '}
                <span className="text-faint">
                  ({usable.wentQuiet} went quiet — counted on its own, never as a loss)
                </span>
              </>
            )}
            .{' '}
            <span className="text-faint">
              The {bindingArm} column is the one holding it back.
            </span>
          </p>
          {unmeasured > 0 && (
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted">
              You do have{' '}
              <strong className="font-medium tabular-nums text-ink">
                {closed.won} won and {closed.lost} lost
              </strong>{' '}
              on the board — but {unmeasured === 1 ? 'one of them has' : `${unmeasured} of them have`}{' '}
              no linked call carrying coaching metrics, so{' '}
              {unmeasured === 1 ? 'it cannot' : 'they cannot'} be compared. Open a deal and link its
              calls under <span className="text-ink">Calls on this deal</span>, or link from the call
              itself.
            </p>
          )}
          {backfillUntrustworthy && (
            <p className="mt-2 max-w-xl rounded-lg bg-elevated px-2.5 py-2 text-[12px] leading-relaxed text-warning">
              Most of the rows you&apos;ve answered so far came back &ldquo;I don&apos;t
              remember&rdquo;. That makes what&apos;s recorded a sample of what was memorable rather
              than of what happened, so nothing will be inferred from it even once the counts are
              met.
            </p>
          )}
        </div>
        {unansweredRows > 0 && (
          <Button variant="secondary" icon={ClipboardList} onClick={onOpenBackfill}>
            Record past outcomes ({unansweredRows})
          </Button>
        )}
      </div>
    </div>
  )
}
