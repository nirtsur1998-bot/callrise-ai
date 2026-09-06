// M36 Stage 3 item 5, step 5 — the window in words, for the prompt.
import { describe, expect, it } from 'vitest'
import { describeValidity, TEMPORAL_RULE } from '../validity-window'

describe('describeValidity', () => {
  it('an undated row says nothing — no claim about what is not known', () => {
    expect(describeValidity({})).toBe('')
    expect(describeValidity({ validFrom: null, validUntil: null })).toBe('')
  })
  it('a live fact: true since its event date', () => {
    expect(describeValidity({ validFrom: '2026-03-14T10:00:00.000Z', validFromSource: 'call' })).toBe(' (true since 2026-03-14)')
  })
  it('an approximate date says "around" and never a precise day', () => {
    expect(describeValidity({ validFrom: '2026-03-14T10:00:00.000Z', validFromSource: 'approx' })).toBe(' (true since around 2026-03-14)')
  })
  it('a superseded fact: its whole window, then superseded', () => {
    expect(
      describeValidity({
        validFrom: '2026-03-14T10:00:00.000Z',
        validFromSource: 'call',
        validUntil: '2026-07-02T15:30:00.000Z',
        validUntilSource: 'call'
      })
    ).toBe(' (true from 2026-03-14 until 2026-07-02, then superseded)')
    expect(
      describeValidity({ validUntil: '2026-07-02T15:30:00.000Z', validUntilSource: 'approx' })
    ).toBe(' (true until around 2026-07-02, then superseded)')
  })
  it('the rule tells the model what "then superseded" and "around" mean', () => {
    expect(TEMPORAL_RULE).toContain('not true now')
    expect(TEMPORAL_RULE).toContain('"around" is approximate')
  })
})
