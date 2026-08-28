// M29 sweep item 6 — the "Send now" status string is a FACTUAL CLAIM about the
// user's own data, on the one screen whose premise is that everything is
// inspectable rather than described. The sweep found a dropped batch reported
// as "Still queued; will retry later" — both clauses false, at the exact moment
// the events were deleted. These assertions pin the claim, not the wording.
import { describe, expect, it } from 'vitest'
import { flushSummary } from '../TelemetrySection'

const base = { attempted: true, sent: 0, remaining: 0 }

describe('flushSummary — a dropped batch must never be described as queued', () => {
  it('a dropped batch says discarded, and never says queued or retry', () => {
    const s = flushSummary({ ...base, reason: 'dropped: HTTP 400' })
    expect(s).toMatch(/discard/i)
    // The two false clauses from the original bug, asserted as absent:
    expect(s).not.toMatch(/still queued/i)
    expect(s).not.toMatch(/will retry/i)
    expect(s).toContain('HTTP 400') // the user can see WHICH rejection
  })

  it('the honest-retry case still says queued — the fix must not blanket-rewrite it', () => {
    const s = flushSummary({ ...base, reason: 'HTTP 503' })
    expect(s).toMatch(/still queued/i)
    expect(s).toMatch(/retry/i)
  })

  it('a successful send reports the count', () => {
    expect(flushSummary({ ...base, sent: 3 })).toBe('Sent 3 events.')
    expect(flushSummary({ ...base, sent: 1 })).toBe('Sent 1 event.')
  })

  it('every drop status the transport can produce is described as discarded', () => {
    for (const status of [400, 409, 413, 422]) {
      const s = flushSummary({ ...base, reason: `dropped: HTTP ${status}` })
      expect(s, `HTTP ${status}`).not.toMatch(/still queued/i)
      expect(s, `HTTP ${status}`).toMatch(/discard/i)
    }
  })

  it('the non-attempted reasons keep their own honest copy', () => {
    expect(flushSummary({ attempted: false, sent: 0, remaining: 0, reason: 'consent off' })).toMatch(
      /off/i
    )
    expect(
      flushSummary({ attempted: false, sent: 0, remaining: 0, reason: 'nothing queued' })
    ).toMatch(/nothing to send/i)
  })
})
