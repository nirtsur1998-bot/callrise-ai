// BUG-241 — "the coach scorecard fails on one missing field" was measured by
// an INSTRUMENT, not by the product. scripts/verification/bug234-baseline.ts
// scores a run "schema-valid" with its own check of the tool schema's
// `required` list, and 8 of its 10 coach failures were a missing
// `strengthQuote`. The product never runs that check: the Anthropic adapter
// only rejects a response with NO tool_use block, and assembleReport treats
// the strength's evidence as optional (an unverifiable quote has always
// rendered as a strength without a quote). The only thing that makes the
// product discard a coaching result is fewer than six unique dimensions.
//
// This pins that, entering where the product enters (coachCall), with the
// exact object shapes the baseline recorded — so the claim "an omitted quote
// discards an otherwise complete assessment" has a test that says whether it
// is true of the PRODUCT, and goes red the day someone adds a required-field
// check between the adapter and the assembler.
import { describe, expect, it, vi } from 'vitest'

const next: { toolInput?: Record<string, unknown> } = {}

vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback: async () => ({ text: '', toolInput: next.toolInput, model: 'test-model' }),
  AllModelsExhaustedError: class extends Error {}
}))
vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('../app-settings', () => ({
  loadAppSettings: () => ({
    coach2: { enabled: false, methodology: 'blended' },
    personalization: { name: '', role: '', pronoun: '', about: '' }
  })
}))
vi.mock('../knowledge-fs', () => ({ listEntries: async () => [] }))
vi.mock('../knowledge-context', () => ({ assembleKnowledgeContext: () => '' }))
vi.mock('../memory/profile-injection', () => ({ repProfileSection: () => '' }))

const { coachCall, buildCoachTool } = await import('../coach')

const REP_LINE = 'What would it cost you if this problem stayed unsolved for another quarter?'
const SEGMENTS = [
  { speaker: 0, text: REP_LINE, role: 'rep' as const, startMs: 0, endMs: 4000 },
  {
    speaker: 1,
    text: 'Honestly, probably two hires.',
    role: 'other' as const,
    startMs: 4000,
    endMs: 7000
  }
]

const DIMENSION_KEYS = (
  buildCoachTool(false).inputSchema as {
    properties: { dimensions: { items: { properties: { key: { enum: string[] } } } } }
  }
).properties.dimensions.items.properties.key.enum

function fullDimensions(): Array<Record<string, unknown>> {
  return DIMENSION_KEYS.map((key) => ({
    key,
    score: 4,
    comment: 'Asked a quantified impact question.',
    evidenceQuote: REP_LINE,
    evidenceSpeaker: 0
  }))
}

/** The seven fields the baseline recorded in 8 of its 10 coach failures —
 *  everything `required` except `strengthQuote`. */
function sevenFieldResult(): Record<string, unknown> {
  return {
    repSpeaker: 0,
    dealContext: { type: 'complex', summary: 'Mid-market evaluation.', lens: 'discovery depth' },
    strengthText: 'Quantified the cost of inaction early.',
    strengthSpeaker: 0,
    dimensions: fullDimensions(),
    improvements: [
      {
        kind: 'mechanical',
        title: 'Confirm the number',
        detail: 'Repeat the figure back before moving on.',
        evidenceQuote: REP_LINE,
        evidenceSpeaker: 0
      }
    ],
    nextAction: 'Send a one-page cost-of-delay summary.'
  }
}

describe('BUG-241 — what the PRODUCT does with the results the baseline scored as failures', () => {
  it('the rubric really has six dimensions in this harness (or every case below is vacuous)', () => {
    expect(DIMENSION_KEYS).toHaveLength(6)
  })

  it('a result missing ONLY strengthQuote still produces a complete report', async () => {
    next.toolInput = sevenFieldResult()
    const result = await coachCall(SEGMENTS, 60_000)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.dimensions).toHaveLength(6)
    expect(result.report.strength.text).toBe('Quantified the cost of inaction early.')
    // The strength renders WITHOUT a quote — the same thing an unverifiable
    // quote has always produced. Absent evidence, not a discarded assessment.
    expect(result.report.strength.evidence).toBeUndefined()
    expect(result.report.improvements).toHaveLength(1)
    expect(result.report.nextAction).toBe('Send a one-page cost-of-delay summary.')
  })

  it('a verbatim strengthQuote, when the model does supply one, is kept as verified evidence', async () => {
    next.toolInput = { ...sevenFieldResult(), strengthQuote: REP_LINE }
    const result = await coachCall(SEGMENTS, 60_000)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.strength.evidence).toMatchObject({ verified: true, speaker: 0 })
  })

  it('the other recorded shape — also missing improvements and nextAction — still reports', async () => {
    const partial = sevenFieldResult()
    delete partial.improvements
    delete partial.nextAction
    next.toolInput = partial
    const result = await coachCall(SEGMENTS, 60_000)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.report.improvements).toEqual([])
    expect(result.report.nextAction).toBe('')
  })

  it('what DOES discard a result: fewer than six unique dimensions', async () => {
    next.toolInput = { ...sevenFieldResult(), dimensions: fullDimensions().slice(0, 5) }
    const result = await coachCall(SEGMENTS, 60_000)

    expect(result.ok).toBe(false)
  })
})
