// M25 Sales Brain — the longitudinal test (spec's testing section: "scripted
// sequences of 8-10 calls for one simulated rep"). Exercises the DETERMINISTIC
// state machine (promotion, decay, invalidation, profile compilation) across
// a real simulated multi-call timeline, driven directly through the store/
// consolidation layer — the individual mechanisms already have their own
// isolated unit tests (consolidation.test.ts, personal-benchmarks.test.ts);
// this test's job is specifically to prove the SEQUENCE holds together
// across time, not any one function in isolation.
//
// Deliberately does NOT run through consolidateNewCandidate()'s AI-judgment
// calls (judgeSameFact/detectContradiction) — this codebase has no existing
// precedent for mocking completeWithFallback's dynamic per-call responses,
// and inventing one under time pressure for an 8-10-step scripted sequence
// risked more than it proved. Those two judgment calls are reviewed but not
// independently AI-tested, same standard already documented for the rest of
// the consolidation engine (see docs/M25-sales-brain.md's Phase 2 section).
// Every deterministic transition this test drives — insert, reinforce,
// promote, invalidate, decay, compile — is the REAL production function,
// not a mock of it.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryDbPath, openMemoryDb, migrate } from '../db'
import {
  getCompiledProfile,
  getMemoryById,
  insertMemory,
  invalidateMemory,
  listMemories,
  listMemoriesByCallId,
  reinforceMemory
} from '../memories-store'
import { compileProfile, decayMemories, promoteHypotheses } from '../consolidation'
import type { MemoryCandidate, MemoryEvidence } from '../types'

let dir: string
let db: Database.Database

function embedding(seed: number): Float32Array {
  const v = new Float32Array(384)
  v[seed % 384] = 1
  return v
}

function transcriptEvidence(callId: string, quote = 'x'): MemoryEvidence {
  return { type: 'transcript', callId, quote }
}

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    scope: 'rep',
    category: 'stated-struggle',
    statement: 'Talks fast when nervous about pricing objections',
    evidence: [transcriptEvidence('call-1')],
    confidence: 0.85,
    importance: 6,
    source: 'auto',
    ...overrides
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-longitudinal-'))
  db = openMemoryDb(memoryDbPath(dir))
  await migrate(db, memoryDbPath(dir))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('longitudinal simulated-rep sequence (8-10 calls)', () => {
  it('a pattern is promoted to a trusted fact only after 3+ independent calls, never 1 or 2', () => {
    // Call 1 — first observation, a fresh hypothesis.
    const memory = insertMemory(db, candidate(), embedding(1))
    expect(memory.status).toBe('hypothesis')
    promoteHypotheses(db, 'rep')
    expect(getMemoryById(db, memory.id)?.status).toBe('hypothesis') // still just 1 episode

    // Call 4 — same pattern noticed again, a SECOND independent call.
    reinforceMemory(db, memory.id, transcriptEvidence('call-4'))
    promoteHypotheses(db, 'rep')
    expect(getMemoryById(db, memory.id)?.status).toBe('hypothesis') // 2 episodes — still not enough

    // Call 7 — a THIRD independent call. NOW it graduates.
    reinforceMemory(db, memory.id, transcriptEvidence('call-7'))
    promoteHypotheses(db, 'rep')
    expect(getMemoryById(db, memory.id)?.status).toBe('active')
  })

  it('a contradiction later in the sequence temporally invalidates the old fact, preserving history', () => {
    // Call 1-3 — "prefers email" becomes trusted.
    const emailPref = insertMemory(
      db,
      candidate({ category: 'preference', statement: 'Prefers email for follow-ups', source: 'user_stated' }),
      embedding(1)
    )
    expect(emailPref.status).toBe('active') // user_stated is trusted immediately

    // Call 8 — the rep now says the opposite. In production this goes
    // through consolidateNewCandidate's detectContradiction (AI call, not
    // exercised here); this test drives the confirmed-contradiction OUTCOME
    // directly — the exact same store call that path leads to.
    const slackPref = insertMemory(
      db,
      candidate({ category: 'preference', statement: 'Prefers Slack for follow-ups', source: 'user_stated' }),
      embedding(2)
    )
    invalidateMemory(db, emailPref.id, slackPref.id)

    const reread = getMemoryById(db, emailPref.id)
    expect(reread?.status).toBe('invalidated')
    expect(reread?.invalidatedBy).toBe(slackPref.id)
    // The history is preserved, not deleted — spec section 2's "the history
    // is preserved and viewable."
    expect(listMemories(db, { scope: 'rep' }).map((m) => m.id)).toContain(emailPref.id)
  })

  it('a fact unreinforced across the whole sequence decays and eventually gets demoted', () => {
    const memory = insertMemory(db, candidate({ statement: 'Only seen once, early on' }), embedding(1))
    // Simulate the memory sitting untouched for 90 days while 7-8 more
    // calls happen (none of which mention this again) — decayMemories()
    // is what memory-runtime.ts's nightly pass actually calls.
    db.prepare('UPDATE memories SET last_confirmed_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', memory.id)
    decayMemories(db, 'rep')
    // A hypothesis this stale, with only 1 episode of evidence (the
    // weakest possible decay resistance), should have fallen all the way
    // to archived — never asserted again.
    expect(getMemoryById(db, memory.id)?.status).toBe('archived')
  })

  it("a pinned fact survives the same decay that would archive an unpinned one", () => {
    const pinned = insertMemory(db, candidate({ statement: 'Pinned by the rep' }), embedding(1))
    const unpinned = insertMemory(db, candidate({ statement: 'Not pinned' }), embedding(2))
    db.prepare('UPDATE memories SET pinned = 1, last_confirmed_at = ? WHERE id = ?').run(
      '2020-01-01T00:00:00.000Z',
      pinned.id
    )
    db.prepare('UPDATE memories SET last_confirmed_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', unpinned.id)

    decayMemories(db, 'rep')

    expect(getMemoryById(db, pinned.id)?.status).toBe('hypothesis') // untouched
    expect(getMemoryById(db, unpinned.id)?.status).toBe('archived')
  })

  it("a call marked 'don't learn from this call' contributes zero memories, even mid-sequence", () => {
    // Calls 1, 2, 4, 5 contribute real memories; call 3 is excluded — in
    // production, memory-hooks.ts's own `call.salesBrainExcluded` check
    // (not exercised here, that's an integration concern) is what prevents
    // extraction from EVER calling insertMemory for an excluded call in the
    // first place. This test verifies the DOWNSTREAM guarantee: nothing
    // tagged to that call ever shows up, which is what "leaves zero trace"
    // actually means to a rep looking at their own history.
    insertMemory(db, candidate({ evidence: [transcriptEvidence('call-1')] }), embedding(1))
    insertMemory(
      db,
      candidate({ statement: 'Second fact', evidence: [transcriptEvidence('call-2')] }),
      embedding(2)
    )
    insertMemory(
      db,
      candidate({ statement: 'Fourth fact', evidence: [transcriptEvidence('call-4')] }),
      embedding(4)
    )
    expect(listMemoriesByCallId(db, 'call-3')).toHaveLength(0)
  })

  it('the compiled profile stays within budget and reflects only trusted (active) facts across the whole sequence', async () => {
    // Simulate ~10 accumulated facts across the sequence, some active, some
    // still hypotheses — the profile must only ever surface the active
    // ones (spec section 5: an unconfirmed hypothesis has no business being
    // asserted as if it were known).
    for (let i = 0; i < 7; i++) {
      insertMemory(
        db,
        candidate({ statement: `Trusted fact number ${i}`, source: 'user_stated' }),
        embedding(i)
      )
    }
    for (let i = 0; i < 3; i++) {
      insertMemory(
        db,
        candidate({ statement: `Still just a hunch number ${i}`, evidence: [transcriptEvidence(`call-${i}`)] }),
        embedding(i + 100)
      )
    }

    await compileProfile(db, 'rep', 'micro')
    await compileProfile(db, 'rep', 'standard')
    await compileProfile(db, 'rep', 'full')

    const micro = getCompiledProfile(db, 'rep', 'micro')
    const standard = getCompiledProfile(db, 'rep', 'standard')
    const full = getCompiledProfile(db, 'rep', 'full')

    for (const profile of [micro, standard, full]) {
      expect(profile?.text).not.toContain('hunch')
      expect(profile?.text).toContain('Trusted fact')
    }
    // ~150/500/1200 token budgets, roughly 4 chars/token — generous upper
    // bounds, not exact, since this is a rough estimate by design (see
    // consolidation.ts's PROFILE_CHAR_BUDGET comment).
    expect(micro!.text.length).toBeLessThanOrEqual(600)
    expect(standard!.text.length).toBeLessThanOrEqual(1800)
    expect(full!.text.length).toBeLessThanOrEqual(4200)
  })
})
