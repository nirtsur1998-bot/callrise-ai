// The bug these exist for: the "scan past calls" loop shares
// mineCallIntoQueue() with the automatic post-call auto-mine hook, and the
// two legitimately collide (a call saved just before a scan starts is still
// unmined when the eligible list is snapshotted, so the scan picks it up
// while the auto-mine's AI call is still in flight). That collision used to
// come back as a plain `ok: false` — indistinguishable from a real API
// failure — and the scan's circuit breaker aborts the entire remaining run
// after 3 consecutive failures. So a few harmless collisions could stop a
// scan dead on a perfectly healthy API and report "stopped after repeated
// errors". Pre-existing (it predates the M26 job migration, which carried
// the loop over unchanged); fixed here by giving a skip its own outcome.
import { describe, expect, it } from 'vitest'
import { createScanTally, CONSECUTIVE_FAILURE_LIMIT } from '../objection-scan-tally'

describe('createScanTally — skips are not failures (the actual bug)', () => {
  it('does NOT abort the scan when collisions exceed the consecutive-failure limit', () => {
    const tally = createScanTally()
    // Far more collisions in a row than the breaker's limit — every one of
    // these is a call the auto-mine hook is already handling.
    for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT * 3; i++) {
      expect(tally.record({ kind: 'skipped' })).toBe('continue')
    }
    expect(tally.state().stopped).toBeUndefined()
    expect(tally.state().failed).toBe(0)
    expect(tally.state().skipped).toBe(CONSECUTIVE_FAILURE_LIMIT * 3)
  })

  it('still aborts on a genuine run of failures', () => {
    const tally = createScanTally()
    for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT - 1; i++) {
      expect(tally.record({ kind: 'failed' })).toBe('continue')
    }
    expect(tally.record({ kind: 'failed' })).toBe('stop')
    expect(tally.state().stopped).toBe('errors')
  })

  it('a skip does not RESET the failure streak — a real outage interleaved with skips still trips the breaker', () => {
    const tally = createScanTally()
    expect(tally.record({ kind: 'failed' })).toBe('continue')
    expect(tally.record({ kind: 'skipped' })).toBe('continue')
    expect(tally.record({ kind: 'failed' })).toBe('continue')
    expect(tally.record({ kind: 'skipped' })).toBe('continue')
    // Third genuine failure — the breaker trips exactly as it would have
    // without the skips in between.
    expect(tally.record({ kind: 'failed' })).toBe('stop')
    expect(tally.state().stopped).toBe('errors')
    expect(tally.state().failed).toBe(CONSECUTIVE_FAILURE_LIMIT)
    expect(tally.state().skipped).toBe(2)
  })

  it('a success DOES reset the failure streak (unchanged behavior)', () => {
    const tally = createScanTally()
    tally.record({ kind: 'failed' })
    tally.record({ kind: 'failed' })
    expect(tally.record({ kind: 'ok', added: 1 })).toBe('continue')
    // Streak reset — two more failures must not be enough to stop.
    expect(tally.record({ kind: 'failed' })).toBe('continue')
    expect(tally.record({ kind: 'failed' })).toBe('continue')
    expect(tally.state().stopped).toBeUndefined()
  })
})

describe('createScanTally — accounting and progress', () => {
  it('counts skips toward itemsDone so progress still reaches the total', () => {
    const tally = createScanTally()
    tally.record({ kind: 'ok', added: 2 })
    tally.record({ kind: 'skipped' })
    tally.record({ kind: 'failed' })
    expect(tally.itemsDone()).toBe(3)
  })

  it('sums candidates only from successful mines', () => {
    const tally = createScanTally()
    tally.record({ kind: 'ok', added: 3 })
    tally.record({ kind: 'skipped' })
    tally.record({ kind: 'ok', added: 2 })
    expect(tally.state().candidatesAdded).toBe(5)
    expect(tally.state().scanned).toBe(2)
  })
})

describe('createScanTally — summary text', () => {
  it('reports skipped calls honestly rather than hiding them', () => {
    const tally = createScanTally()
    tally.record({ kind: 'ok', added: 2 })
    tally.record({ kind: 'skipped' })
    expect(tally.summary()).toBe('Scanned 1 call, found 2 suggestions, 1 already being mined')
  })

  it('omits the skipped clause entirely when there were none', () => {
    const tally = createScanTally()
    tally.record({ kind: 'ok', added: 1 })
    expect(tally.summary()).toBe('Scanned 1 call, found 1 suggestion')
  })

  it('reports a toggle-off stop distinctly from an error stop', () => {
    const tally = createScanTally()
    tally.record({ kind: 'ok', added: 0 })
    tally.stopDisabled()
    expect(tally.summary()).toBe('Scanned 1 call, found 0 suggestions, stopped — toggle turned off')
  })

  it('reports an error stop', () => {
    const tally = createScanTally()
    for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT; i++) tally.record({ kind: 'failed' })
    expect(tally.summary()).toBe(
      'Scanned 0 calls, found 0 suggestions, 3 failed, stopped after repeated errors'
    )
  })
})
