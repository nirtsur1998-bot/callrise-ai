// M32 Stage 2 — the gate.
//
// Most of these tests are about the gate REFUSING. That is deliberate: for the
// founder's actual data (4 deals, all won, zero lost) the correct answer is
// "nothing can be compared", and it will stay the correct answer for months.
// A gate whose open path is well tested and whose closed path is not would be
// exactly backwards for a feature that spends its whole first year closed.
import { describe, expect, it } from 'vitest'
import {
  countAnswers,
  evaluateGate,
  EMPTY_COUNTS,
  MIN_PER_ARM,
  DONT_REMEMBER_DISTRUST_RATIO,
  type OutcomeSample,
  type BackfillAnswer
} from '../deal-outcomes'

const deals = (kind: OutcomeSample['kind'], n: number, hasMetricCall = true): OutcomeSample[] =>
  Array.from({ length: n }, (_, i) => ({ dealId: `${kind}-${i}`, kind, hasMetricCall }))

const counts = (over: Partial<typeof EMPTY_COUNTS> = {}) => ({ ...EMPTY_COUNTS, ...over })

describe('the gate is CLOSED unless both arms clear the bar', () => {
  it("the founder's actual data today — 4 won, 0 lost — is insufficient", () => {
    const g = evaluateGate(deals('won', 4), counts({ won: 4 }))
    expect(g.status).toBe('insufficient')
  })

  it('a 20-and-2 split is 2 — the bar is per ARM and NEVER a total', () => {
    // THE DISCRIMINATING CASE, and it took a red check to find it. The obvious
    // way to write this test is 12 won and 0 lost — which passes whether the
    // gate is per-arm or a 16-deal total, because 12 clears neither. It asserts
    // its own name and proves nothing.
    //
    // 22 closed deals is far MORE than 8+8, so a gate that summed the arms
    // would open right here. Only a per-arm gate keeps it shut.
    const g = evaluateGate(
      [...deals('won', 20), ...deals('lost', 2)],
      counts({ won: 20, lost: 2 })
    )
    expect(g.status, 'a summed gate would open on 22 deals; the bar is per arm').toBe(
      'insufficient'
    )
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.usable.won + g.usable.lost, 'the total is well over 2 × the bar').toBeGreaterThan(
      MIN_PER_ARM * 2
    )
    expect(g.bindingArm, 'the LOST arm is what is short, and must be named').toBe('lost')
  })

  it('one short in either arm keeps it closed', () => {
    const short = [...deals('won', MIN_PER_ARM), ...deals('lost', MIN_PER_ARM - 1)]
    expect(evaluateGate(short, counts()).status).toBe('insufficient')
  })

  it('both arms at the bar opens it', () => {
    const enough = [...deals('won', MIN_PER_ARM), ...deals('lost', MIN_PER_ARM)]
    expect(evaluateGate(enough, counts()).status).toBe('ready')
  })
})

describe('a closed deal with no measurable call does not count', () => {
  it('deals without a metric-carrying call never reach the bar', () => {
    // Otherwise the counter promises an analysis that can never run: the deals
    // exist, the counts look met, and there is nothing to actually compare.
    const unmeasurable = [
      ...deals('won', MIN_PER_ARM, false),
      ...deals('lost', MIN_PER_ARM, false)
    ]
    const g = evaluateGate(unmeasurable, counts())
    expect(g.status).toBe('insufficient')
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.usable).toEqual({ won: 0, lost: 0, wentQuiet: 0 })
  })

  it('closed counts every closed deal; usable counts only the measurable ones', () => {
    // The distinction the counter reads, and the reason it was added: four won
    // deals with no linked coached call is "0 countable, 4 on the board", not
    // "0 deals". Reporting those two situations identically is what sent the
    // founder to a card that said 0 while their board said 4.
    const g = evaluateGate(deals('won', 4, false), counts({ won: 4 }))
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.closed.won, 'closed must see deals that carry no metrics').toBe(4)
    expect(g.usable.won, 'usable must NOT see them').toBe(0)
  })

  it('closed is never what the gate opens on', () => {
    // The load-bearing half. If the bar were ever read off `closed`, the gate
    // would open on deals with nothing to compare and the analysis would run
    // on an empty join — the exact promise-an-analysis-that-cannot-run failure
    // `hasMetricCall` exists to prevent.
    const plenty = [...deals('won', 20, false), ...deals('lost', 20, false)]
    const g = evaluateGate(plenty, counts())
    expect(g.status, 'the gate opened on deals with no measurable calls').toBe('insufficient')
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.closed.won).toBe(20)
    expect(g.usable.won).toBe(0)
  })

  it('mixed: only the measurable ones are counted', () => {
    const mixed = [
      ...deals('won', MIN_PER_ARM, true),
      ...deals('lost', MIN_PER_ARM - 1, true),
      ...deals('lost', 5, false) // plenty of lost deals, none measurable
    ]
    const g = evaluateGate(mixed, counts())
    expect(g.status).toBe('insufficient')
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.usable.lost).toBe(MIN_PER_ARM - 1)
  })
})

describe("'went quiet' is counted as its own arm and never folded into 'lost'", () => {
  it('went-quiet deals do NOT help the lost arm reach the bar', () => {
    // The merge this whole outcome kind exists to prevent. If went-quiet
    // counted as lost, the gate would open on a mixture of "they said no" and
    // "it evaporated" and every later claim would be about both at once.
    const g = evaluateGate(
      [...deals('won', MIN_PER_ARM), ...deals('went-quiet', MIN_PER_ARM)],
      counts()
    )
    expect(g.status).toBe('insufficient')
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.usable.wentQuiet).toBe(MIN_PER_ARM)
    expect(g.usable.lost).toBe(0)
  })
})

describe('the backfill reports its own trustworthiness', () => {
  it('mostly "I don\'t remember" marks the sample untrustworthy', () => {
    const c = countAnswers(
      [...Array(12).fill('dont-remember'), 'won', 'lost'] as BackfillAnswer[],
      19
    )
    const g = evaluateGate([], c)
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.backfillUntrustworthy).toBe(true)
  })

  it('a well-answered backfill is not flagged', () => {
    const c = countAnswers(
      ['won', 'won', 'lost', 'went-quiet', 'not-a-deal', 'dont-remember'] as BackfillAnswer[],
      19
    )
    const g = evaluateGate([], c)
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.backfillUntrustworthy).toBe(false)
  })

  it('an UNTRUSTWORTHY backfill keeps the gate shut even with both arms full', () => {
    // The important one. Counts can be met while the sample they came from is
    // known to be biased — and a gate that opens on biased-but-sufficient data
    // is worse than one that never opens, because the output looks earned.
    const c = countAnswers(
      Array(20).fill('dont-remember').concat(['won', 'lost']) as BackfillAnswer[],
      22
    )
    const g = evaluateGate([...deals('won', 10), ...deals('lost', 10)], c)
    expect(g.status).toBe('insufficient')
  })

  it('"not a deal" is not distrust — it is a clean answer', () => {
    const c = countAnswers(Array(15).fill('not-a-deal') as BackfillAnswer[], 19)
    const g = evaluateGate([], c)
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.backfillUntrustworthy, 'knowing it was never a deal is knowledge').toBe(false)
  })

  it('the distrust ratio is a share of ANSWERED rows, not of the whole list', () => {
    // Answering 2 of 19 with one "don't remember" is 50% distrust, not 5%.
    // If the denominator were the list size, `backfillUntrustworthy` could never
    // fire early — the founder would answer six rows, three of them "I don't
    // remember", and the counter would report a clean sample.
    const c = countAnswers(['won', 'dont-remember'] as BackfillAnswer[], 19)
    expect(c.unanswered, 'unanswered rows are tracked separately, not as distrust').toBe(17)

    // Exactly AT the line is not over it, so this pair is trustworthy...
    expect(DONT_REMEMBER_DISTRUST_RATIO).toBe(0.5)
    const at = evaluateGate([], c)
    if (at.status !== 'insufficient') throw new Error('unreachable')
    expect(at.backfillUntrustworthy).toBe(false)

    // ...and one more unremembered row, with the LIST SIZE UNCHANGED, tips it.
    // Same 19-row list, so only the answered-share can be what moved.
    const over = countAnswers(['won', 'dont-remember', 'dont-remember'] as BackfillAnswer[], 19)
    const past = evaluateGate([], over)
    if (past.status !== 'insufficient') throw new Error('unreachable')
    expect(past.backfillUntrustworthy, '2 of 3 answered is distrust regardless of list size').toBe(
      true
    )
  })
})

describe('the insufficient arm carries NO analysis numbers — structurally', () => {
  it('has counts and usable totals, and nothing resembling a finding', () => {
    // THE STRUCTURAL GUARANTEE. Nothing here is an effect size, a direction, a
    // percentage or a trend, so there is nothing a renderer could display as
    // one — and no number for a caveat to be read as. Enumerated rather than
    // asserted in prose: a new field slipping onto this arm fails here.
    const g = evaluateGate(deals('won', 4), counts({ won: 4 }))
    expect(Object.keys(g).sort()).toEqual(
      [
        'backfillUntrustworthy',
        'bindingArm',
        'closed',
        'counts',
        'needPerArm',
        'status',
        'usable'
      ].sort()
    )
  })

  it('counts are a description of what was recorded, not of what it means', () => {
    const g = evaluateGate(deals('won', 4), counts({ won: 4, dontRemember: 1 }))
    if (g.status !== 'insufficient') throw new Error('unreachable')
    expect(g.counts.won).toBe(4)
    expect(g.needPerArm).toBe(MIN_PER_ARM)
  })
})
