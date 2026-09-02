// M32 Stage 2 — outcome counting, and the gate that decides whether anything
// may be said about it.
//
// PURE LOGIC ON PURPOSE. No Electron, no filesystem, no IPC — same convention
// as purpose-health.ts and deal-stages' sanitizers, so every branch below is
// reachable from a test without mocking anything. The storage and IPC live
// with the deals themselves.
//
// ── WHAT THIS MODULE IS ACTUALLY FOR ────────────────────────────────────
//
// The analysis it gates does not exist yet and will not for a long time. The
// founder's own data: 4 deals, all won, zero lost. The gate needs 8 in EACH
// arm. So the honest output of this module, today and for months, is
// "nothing can be compared yet" — and making that the DEFAULT, structural,
// unbypassable answer is the entire job.
import type { DealStageKind } from './deal-stages'

/**
 * What the founder said about a contact during the backfill.
 *
 * Five answers, not three, and each of the last two is a REAL answer rather
 * than a skip:
 *
 *   - won / lost / went-quiet   → a deal exists and closed this way
 *   - dont-remember             → they looked and genuinely do not know
 *   - not-a-deal                → it was never a pursuit (support, a
 *                                 colleague, a test call)
 *
 * `dont-remember` and `not-a-deal` are deliberately distinguished from each
 * other AND from an unanswered row. Collapsing them would destroy the one
 * diagnostic this backfill produces for free: **if most rows come back
 * `dont-remember`, the backfill cannot be trusted**, and the counter must say
 * so rather than quietly counting the rows that did produce a deal. A backfill
 * that answers 6 of 19 and reports "6 deals" is a memory-driven sample wearing
 * a list-driven costume.
 */
export type BackfillAnswer = 'won' | 'lost' | 'went-quiet' | 'dont-remember' | 'not-a-deal'

/** The answers that actually produce a closed deal. */
export const OUTCOME_ANSWERS: readonly BackfillAnswer[] = ['won', 'lost', 'went-quiet']

export interface OutcomeCounts {
  won: number
  lost: number
  wentQuiet: number
  /** Rows answered "I don't remember" — the trust signal, not padding. */
  dontRemember: number
  /** Rows answered "this was never a deal". */
  notADeal: number
  /** Rows in the backfill list that have not been answered at all. */
  unanswered: number
}

export const EMPTY_COUNTS: OutcomeCounts = {
  won: 0,
  lost: 0,
  wentQuiet: 0,
  dontRemember: 0,
  notADeal: 0,
  unanswered: 0
}

/**
 * Deals needed in EACH arm before any comparison is attempted.
 *
 * Eight, and it is a judgment rather than a derivation — labelled as one
 * because pretending otherwise is the exact dishonesty this stage guards
 * against. Approved by the founder 2026-08-31 with the reasoning that the
 * leave-one-out condition below does the real work, and this number mainly
 * stops that work running on samples too small to be worth computing.
 *
 * **8 in EACH arm, never 16 between them.** A 12-and-2 split is 2. The binding
 * constraint is almost always the LOST arm, so the closed deals actually
 * required scale with the win rate: 16 at 50%, 20 at 60%, 27 at 70%.
 */
export const MIN_PER_ARM = 8

/**
 * Above this share of `dont-remember`, the backfill is reporting more about
 * the founder's memory than about their pipeline, and the counter says so.
 *
 * Half. Chosen, not derived: at that point the answered rows are a minority of
 * the list and there is no reason to believe they are a representative one —
 * which is precisely the memorability bias the list-driven design exists to
 * avoid. Better to say "this sample cannot be trusted" than to quietly analyse
 * the half that happened to be memorable.
 */
export const DONT_REMEMBER_DISTRUST_RATIO = 0.5

/**
 * A deal, reduced to what the gate needs. Deliberately not the full `Deal`:
 * this module must not be able to read a title, a note or a value, so it
 * cannot accidentally surface one.
 */
export interface OutcomeSample {
  dealId: string
  kind: DealStageKind
  /** Whether at least one linked call carries the metric being compared.
   *  A closed deal with no measurable call contributes NOTHING and must never
   *  inflate a count toward the gate — the counter would then promise an
   *  analysis that can never run. */
  hasMetricCall: boolean
}

/**
 * THE INSIGHT TYPE — and the reason it is a discriminated union.
 *
 * The `insufficient` arm carries **counts and nothing else**. No effect size,
 * no direction, no percentage, no "trend", not even a hint of one. There is
 * therefore nothing for a renderer to accidentally display, no weak signal to
 * attach a caveat to, and no number for a caveat to be read as.
 *
 * The founder's line, which is the whole design: *a caveat next to a number
 * gets read as a number.* So the number must not exist. Same remedy Stage 1
 * used for the status dot, one layer up.
 *
 * Counts are safe to carry because they are not analysis output — they are a
 * description of what has been recorded, which is exactly what the founder
 * asked to be able to see while the analysis stays dormant.
 */
export type Insight =
  | {
      status: 'insufficient'
      counts: OutcomeCounts
      /** Deals in each arm that are actually usable (closed AND measurable). */
      usable: { won: number; lost: number; wentQuiet: number }
      /**
       * Deals in each arm REGARDLESS of whether any call is linked to them.
       *
       * Added 2026-08-31 after rendering the counter against real data: it
       * said *"You have 0 won and 0 lost"* to someone whose board plainly
       * showed four won deals. Both numbers were right — `usable` is zero
       * because none of those four has a linked call carrying coaching
       * metrics — but the screen gave no way to tell "you have no deals" from
       * "your deals have no measurable calls", and those need opposite
       * actions. Only rendering it found this; every test was green.
       *
       * Still not analysis output: a count of what is recorded, exactly like
       * `counts` above.
       */
      closed: { won: number; lost: number; wentQuiet: number }
      needPerArm: number
      /** The arm furthest from the bar — what would actually have to change. */
      bindingArm: 'won' | 'lost'
      /** True when so many rows came back unremembered that the answered ones
       *  are not a trustworthy sample. Reported, never silently ignored. */
      backfillUntrustworthy: boolean
    }
  | {
      status: 'ready'
      counts: OutcomeCounts
      usable: { won: number; lost: number; wentQuiet: number }
      closed: { won: number; lost: number; wentQuiet: number }
    }

export function countAnswers(answers: readonly BackfillAnswer[], listSize: number): OutcomeCounts {
  const c: OutcomeCounts = { ...EMPTY_COUNTS }
  for (const a of answers) {
    if (a === 'won') c.won++
    else if (a === 'lost') c.lost++
    else if (a === 'went-quiet') c.wentQuiet++
    else if (a === 'dont-remember') c.dontRemember++
    else if (a === 'not-a-deal') c.notADeal++
  }
  c.unanswered = Math.max(0, listSize - answers.length)
  return c
}

/**
 * THE ONLY WAY TO GET AN INSIGHT. There is no exported path that produces a
 * `'ready'` value without passing through this function, and the comparison
 * that would compute an effect size is not exported at all — it does not yet
 * exist, and when it does it will be private to this module and reachable only
 * from the `'ready'` branch below.
 *
 * `lost` and `went-quiet` are counted as SEPARATE arms and neither is merged
 * into the other. Merging them is the thing 'went-quiet' was added to prevent:
 * the behaviours before a refusal and before a fade are not the same
 * behaviours. Today the gate is evaluated against won-vs-lost, because that is
 * the comparison the founder asked for; went-quiet is counted, reported, and
 * deliberately not folded in.
 */
export function evaluateGate(samples: readonly OutcomeSample[], counts: OutcomeCounts): Insight {
  const usableOf = (kind: DealStageKind): number =>
    samples.filter((s) => s.kind === kind && s.hasMetricCall).length

  const usable = {
    won: usableOf('won'),
    lost: usableOf('lost'),
    wentQuiet: usableOf('went-quiet')
  }

  // Every closed deal, measurable or not. The gate does NOT use this — it
  // gates on `usable` — but the counter needs it to tell "no deals" apart
  // from "no measurable calls on them".
  const closedOf = (kind: DealStageKind): number =>
    samples.filter((s) => s.kind === kind).length
  const closed = {
    won: closedOf('won'),
    lost: closedOf('lost'),
    wentQuiet: closedOf('went-quiet')
  }

  const answered = counts.won + counts.lost + counts.wentQuiet + counts.dontRemember + counts.notADeal
  const backfillUntrustworthy =
    answered > 0 && counts.dontRemember / answered > DONT_REMEMBER_DISTRUST_RATIO

  const meetsBar = usable.won >= MIN_PER_ARM && usable.lost >= MIN_PER_ARM

  if (!meetsBar || backfillUntrustworthy) {
    return {
      status: 'insufficient',
      counts,
      usable,
      closed,
      needPerArm: MIN_PER_ARM,
      // The arm that is furthest away — what would actually have to change.
      // Reporting "8 of 16" would hide that 12-and-0 is not 12.
      bindingArm: usable.lost <= usable.won ? 'lost' : 'won',
      backfillUntrustworthy
    }
  }

  return { status: 'ready', counts, usable, closed }
}
