// BUG-274 — an objection-mining failure must keep its cause all the way to
// the Activity Center. Seen on a real call: the job failed with "Could not
// mine this call for objections." in the same minute ai-fallback-events.jsonl
// recorded a Groq rate limit — and the job's error carried none of it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  GENERIC_MINE_FAILURE,
  autoMineJobResult,
  failedMineOutcome
} from '../objection-mine-outcome'

describe('failedMineOutcome — the hop that used to drop the cause', () => {
  it('carries the miner’s classification and sentence', () => {
    const outcome = failedMineOutcome({
      ok: false,
      error: 'failed',
      message: 'Every AI provider is rate-limited right now. Try again in about a minute.'
    })
    expect(outcome).toEqual({
      ok: false,
      added: 0,
      error: 'failed',
      message: 'Every AI provider is rate-limited right now. Try again in about a minute.'
    })
  })

  it('keeps a no-key failure distinguishable from a transient one', () => {
    const noKey = failedMineOutcome({
      ok: false,
      error: 'no-key',
      message: 'Add an AI provider API key in Settings first.'
    })
    expect(noKey.error).toBe('no-key')
    expect(noKey.skipped).toBeUndefined()
    expect(noKey.nothingToMine).toBeUndefined()
  })
})

describe('autoMineJobResult — what the job says', () => {
  it('a rate limit and a missing key no longer produce the same sentence', () => {
    const messageOf = (message?: string): string => {
      try {
        autoMineJobResult({ ok: false, added: 0, error: 'failed', message })
      } catch (err) {
        return (err as Error).message
      }
      throw new Error('a failed outcome must throw, so the job is recorded as failed')
    }
    const rateLimited = messageOf('Every AI provider is rate-limited right now.')
    const noKey = messageOf('Add an AI provider API key in Settings first.')

    expect(rateLimited).not.toBe(noKey)
    expect(rateLimited).toContain('rate-limited')
    expect(noKey).toContain('API key')
    // Still names the feature, so the Activity Center row is readable alone.
    expect(rateLimited.startsWith(GENERIC_MINE_FAILURE)).toBe(true)
  })

  it('falls back to the generic sentence only when there really is no cause', () => {
    expect(() => autoMineJobResult({ ok: false, added: 0 })).toThrow(GENERIC_MINE_FAILURE)
    expect(() => autoMineJobResult({ ok: false, added: 0, message: '   ' })).toThrow(
      new RegExp(`^${GENERIC_MINE_FAILURE.replace('.', '\\.')}$`)
    )
  })

  it('non-events stay non-events — never a red row', () => {
    expect(autoMineJobResult({ ok: false, added: 0, skipped: true })).toMatch(/already being mined/)
    expect(autoMineJobResult({ ok: false, added: 0, nothingToMine: true })).toBe(
      'no transcript to mine'
    )
  })

  it('success reads naturally for one and for many', () => {
    expect(autoMineJobResult({ ok: true, added: 1 })).toBe('found 1 suggestion')
    expect(autoMineJobResult({ ok: true, added: 3 })).toBe('found 3 suggestions')
    expect(autoMineJobResult({ ok: true, added: 0 })).toBe('found 0 suggestions')
  })
})

// calls.ts cannot be imported in a unit test (it registers the whole IPC
// surface), so — same technique as objection-queue-backup.test.ts — the wiring
// is pinned from its source: the two hops must go THROUGH the functions above,
// and the old flattening lines must be gone.
describe('calls.ts is wired through it', () => {
  const calls = readFileSync(join(__dirname, '..', 'calls.ts'), 'utf8')

  it('mineCallIntoQueue returns failedMineOutcome(result), not a bare failure', () => {
    expect(calls).toContain('return failedMineOutcome(result)')
    expect(calls).not.toContain('if (!result.ok) return { ok: false, added: 0 }')
  })

  it('the auto-mine job returns autoMineJobResult(res), not a constant sentence', () => {
    expect(calls).toContain('return autoMineJobResult(res)')
    expect(calls).not.toContain("throw new Error('Could not mine this call for objections.')")
  })
})
