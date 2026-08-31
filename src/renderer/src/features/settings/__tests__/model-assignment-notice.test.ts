// BUG-149 follow-up — the "your chain could cross providers now" notice.
//
// Tested as a pure function because this repo cannot assert on rendered output
// (BUG-140), same as deriveStatusDot and demotionNotice.
//
// What it must never do is fire when nothing is wrong. A notice that appears on
// a healthy install is one people learn to dismiss, and then it is worth less
// than nothing — it trains the habit of ignoring exactly this kind of line.
import { describe, expect, it } from 'vitest'
import { improvableChainNotice } from '../ModelAssignmentSection'

describe('improvableChainNotice', () => {
  it('says nothing at all when no job needs it — the common case', () => {
    expect(improvableChainNotice([])).toBeNull()
  })

  it('names the job, why it matters, and what fixes it', () => {
    const msg = improvableChainNotice(['Live in-call coaching cues'])
    expect(msg).toContain('Live in-call coaching cues')
    // WHY: the point is resilience when the first provider is unavailable, not
    // tidiness. If this drops out, the notice becomes a nag with no stated cost.
    expect(msg).toMatch(/rate-limited or down/i)
    // WHAT FIXES IT, and the reassurance that it does not overwrite their pick —
    // BUG-149's fix is future-only precisely so the app never rewrites a
    // choice, and the notice must not imply otherwise.
    expect(msg).toMatch(/reassign/i)
    expect(msg).toMatch(/keeps the model you picked/i)
  })

  it('reads as English for one job and for several', () => {
    expect(improvableChainNotice(['A'])).toMatch(/^A falls back/)
    expect(improvableChainNotice(['A', 'B'])).toMatch(/^A and B fall back/)
    expect(improvableChainNotice(['A', 'B', 'C'])).toMatch(/^A, B and C fall back/)
  })

  it('is a pure function of its input', () => {
    // Same reason demotionNotice is: a notice built from Date.now() at render
    // time is an impure call during render, and can disagree with itself
    // between two renders of identical state.
    const titles = ['Post-call summary']
    expect(improvableChainNotice(titles)).toBe(improvableChainNotice(titles))
  })
})
