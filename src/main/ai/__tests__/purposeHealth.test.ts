// BUG-058 Phase 3 — messageFor()'s new period-exhausted branch, tested
// directly against purpose-health.ts's pure functions (no Electron/IPC/
// persistence involved — see that file's own header comment on why this is
// deliberately pure logic). purpose-health-store.test.ts already covers the
// persistence/IPC layer around this; this file covers the actual copy the
// founder asked to be honest about: a real reset time when one exists, an
// explicit "we don't know" when it doesn't — never a guessed duration
// dressed up as a fact.
import { describe, expect, it } from 'vitest'
import { emptyHealth, messageFor, recordFailure } from '../purpose-health'

describe('messageFor — period-exhausted vs. an ordinary rate limit', () => {
  it('an ordinary rate-limit (no failureClass, or failureClass !== period-exhausted) keeps the existing copy', () => {
    const h = recordFailure(emptyHealth(), '2026-08-14T12:00:00.000Z', {
      reason: 'rate-limit',
      providerId: 'groq'
      // no failureClass — the ambiguous-default case, same as effectiveFailureClass()'s own rule
    })
    const { text, action } = messageFor(h, 'Groq')
    expect(text).toContain('rate-limiting your key')
    expect(text).not.toContain('quota is used up')
    expect(action).toBe('ai-setup')
  })

  it('a period-exhausted rate-limit WITH a real resetsAt names the actual time, not a guess', () => {
    const resetsAt = new Date('2026-08-14T16:30:00.000Z').getTime()
    const h = recordFailure(emptyHealth(), '2026-08-14T12:00:00.000Z', {
      reason: 'rate-limit',
      providerId: 'groq',
      failureClass: 'period-exhausted',
      resetsAt
    })
    const { text, action } = messageFor(h, 'Groq')
    expect(text).toContain("Groq's free-tier quota is used up")
    expect(text).toContain('resets around')
    expect(text).not.toContain("don't know")
    expect(action).toBe('ai-setup')
  })

  it('a period-exhausted rate-limit WITHOUT a resetsAt says so honestly — never invents a duration', () => {
    const h = recordFailure(emptyHealth(), '2026-08-14T12:00:00.000Z', {
      reason: 'rate-limit',
      providerId: 'groq',
      failureClass: 'period-exhausted'
      // no resetsAt — the genuinely-unknown case (e.g. NVIDIA/Cerebras/Mistral)
    })
    const { text, action } = messageFor(h, 'Groq')
    expect(text).toContain("Groq's free-tier quota is used up")
    expect(text).toContain("don't know exactly when it resets")
    expect(text).not.toContain('resets around')
    expect(action).toBe('ai-setup')
  })

  it('a NON-rate-limit failure never gets period-exhausted copy, even if failureClass/resetsAt are set (defense in depth)', () => {
    // recordFailure/messageFor key on lastFailureReason first (a switch), so
    // this proves the period-exhausted branch is scoped to the 'rate-limit'
    // case specifically, not accidentally reachable from an unrelated reason.
    const h = recordFailure(emptyHealth(), '2026-08-14T12:00:00.000Z', {
      reason: 'failed',
      providerId: 'groq',
      failureClass: 'period-exhausted',
      resetsAt: Date.now() + 1000
    })
    const { text } = messageFor(h, 'Groq')
    expect(text).not.toContain('quota is used up')
  })
})
