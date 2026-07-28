import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../ai', () => ({
  getActiveAIProvider: () => null,
  AIProviderError: class extends Error {}
}))

const { sanitizeCommitments, byOwner } = await import('../commitments')

describe('sanitizeCommitments', () => {
  it('keeps well-formed commitments from both sides', () => {
    const out = sanitizeCommitments([
      { owner: 'rep', text: 'Send the SOC 2 report' },
      { owner: 'prospect', text: 'Loop in the CISO' }
    ])
    expect(out).toHaveLength(2)
    expect(out[0].owner).toBe('rep')
  })

  // A commitment with a guessed owner is worse than none: the rep acts on the
  // list without re-reading the call, and chasing a prospect for something YOU
  // promised is a specific and memorable way to lose trust.
  it('drops anything whose owner is not one of the two sides', () => {
    expect(
      sanitizeCommitments([
        { owner: 'someone', text: 'x' },
        { owner: '', text: 'y' },
        { text: 'z' },
        { owner: 'rep', text: 'kept' }
      ])
    ).toEqual([{ owner: 'rep', text: 'kept' }])
  })

  it('drops entries with no text', () => {
    expect(sanitizeCommitments([{ owner: 'rep', text: '   ' }, { owner: 'rep' }])).toEqual([])
  })

  it('treats the same promise restated later as one commitment', () => {
    const out = sanitizeCommitments([
      { owner: 'rep', text: 'Send pricing' },
      { owner: 'rep', text: 'send pricing' }
    ])
    expect(out).toHaveLength(1)
  })

  it('keeps the same words from different people as two commitments', () => {
    const out = sanitizeCommitments([
      { owner: 'rep', text: 'Send the doc' },
      { owner: 'prospect', text: 'Send the doc' }
    ])
    expect(out).toHaveLength(2)
  })

  it('keeps a real stated date', () => {
    const out = sanitizeCommitments([{ owner: 'rep', text: 'Send it', dueDate: '2026-08-14' }])
    expect(out[0].dueDate).toBe('2026-08-14')
  })

  // 2026-02-31 parses happily in JS and becomes March 3rd, which would put a
  // due date on a day nobody mentioned.
  it('drops a date that does not exist rather than rolling it forward', () => {
    expect(
      sanitizeCommitments([{ owner: 'rep', text: 'x', dueDate: '2026-02-31' }])[0].dueDate
    ).toBeUndefined()
  })

  it('drops a malformed or non-ISO date', () => {
    for (const d of ['next week', '14/08/2026', '2026-8-4', 42, null, '2026-08-14T00:00:00Z']) {
      expect(
        sanitizeCommitments([{ owner: 'rep', text: 'x', dueDate: d }])[0].dueDate
      ).toBeUndefined()
    }
  })

  it('omits dueDate entirely rather than storing undefined', () => {
    expect(Object.hasOwn(sanitizeCommitments([{ owner: 'rep', text: 'x' }])[0], 'dueDate')).toBe(
      false
    )
  })

  it('truncates an over-long commitment rather than dropping it', () => {
    const out = sanitizeCommitments([{ owner: 'rep', text: 'x'.repeat(500) }])
    expect(out[0].text.length).toBeLessThanOrEqual(160)
  })

  it('caps how many one call may produce', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ owner: 'rep', text: `task ${i}` }))
    expect(sanitizeCommitments(many).length).toBeLessThanOrEqual(20)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['an object', { commitments: [] }]
  ])('returns an empty list for %s', (_l, input) => {
    expect(sanitizeCommitments(input)).toEqual([])
  })
})

describe('byOwner', () => {
  it('separates the rep’s list from the prospect’s', () => {
    const split = byOwner([
      { owner: 'rep', text: 'a' },
      { owner: 'prospect', text: 'b' },
      { owner: 'rep', text: 'c' }
    ])
    expect(split.rep).toHaveLength(2)
    expect(split.prospect).toHaveLength(1)
  })

  it('always returns both keys, even when one side promised nothing', () => {
    const split = byOwner([])
    expect(split.rep).toEqual([])
    expect(split.prospect).toEqual([])
  })
})
