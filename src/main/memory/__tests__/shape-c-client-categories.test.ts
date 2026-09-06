// BUG-196 shape (c) — client categories (the founder's decision, 2026-09-06
// night; design in docs/M36-bug196-shape-c-design.md).
//
// The two things the founder weighed are pinned here, not merely argued:
//
//  1. A category can never leak. The scope of a client fact is built from the
//     call's contact id and nothing the model says; every `client-*` name is
//     bound to the client scope kind; the reverse direction (a client
//     category claimed for the rep or the business) still drops. Enumerated
//     over the taxonomy, so a seventh client category cannot be added
//     unbound or unpinned.
//  2. A wrong category costs a label and nothing else. Within a client scope,
//     contradiction detection runs across the whole client family, so a
//     budget filed as a need still supersedes a budget filed as a budget.
//     Rep and business scopes keep the same-category rule; the control below
//     proves the family rule did not widen them.
//
// The contradiction tests drive the REAL consolidateNewCandidate against a
// REAL SQLite DB, with only the two AI judgments mocked (same pattern as
// consolidation.contradiction-hypotheses.test.ts).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ai = {
  sameFact: false,
  contradictsIndex: null as number | null,
  contradictionPrompts: [] as string[]
}

vi.mock('../../ai/complete-with-fallback', () => ({
  completeWithFallback: async (req: { tool?: { name?: string }; messages: Array<{ content: string }> }) => {
    if (req.tool?.name === 'judge_same_fact') return { toolInput: { sameFact: ai.sameFact } }
    ai.contradictionPrompts.push(req.messages[0].content)
    return { toolInput: { contradictsIndex: ai.contradictsIndex } }
  },
  AllModelsExhaustedError: class extends Error {}
}))

vi.mock('../embeddings', () => ({
  embedText: async (s: string) => {
    const v = new Float32Array(384)
    let h = 0
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    v[h % 384] = 1
    return v
  },
  EMBEDDING_DIMENSIONS: 384
}))

const { CATEGORY_SCOPE_KIND, CLIENT_RESIDUAL_CATEGORY, MEMORY_CATEGORIES, isClientCategory } = await import('../types')
const { resolveScopeAndCategory, verifyCandidate } = await import('../extraction')
const { memoryDbPath, openMemoryDb, migrate } = await import('../db')
const { getMemoryById, listMemories } = await import('../memories-store')
const { consolidateNewCandidate } = await import('../consolidation')
type MemoryCandidate = import('../types').MemoryCandidate
type MemoryCategory = import('../types').MemoryCategory

const CLIENT_CATEGORIES = MEMORY_CATEGORIES.filter((c) => CATEGORY_SCOPE_KIND[c] === 'client')
const NAMED_CLIENT_CATEGORIES = CLIENT_CATEGORIES.filter((c) => c !== CLIENT_RESIDUAL_CATEGORY)

describe('shape (c) — the taxonomy, pinned in both directions', () => {
  it('has the five named client categories plus the residual', () => {
    expect(NAMED_CLIENT_CATEGORIES).toEqual([
      'client-budget',
      'client-timeline',
      'client-decision',
      'client-need',
      'client-concern'
    ])
    expect(CLIENT_RESIDUAL_CATEGORY).toBe('client-fact')
  })
  it('every category whose name starts with client- binds to the client scope kind, and no other does', () => {
    for (const c of MEMORY_CATEGORIES) {
      expect(CATEGORY_SCOPE_KIND[c] === 'client', c).toBe(c.startsWith('client-'))
      expect(isClientCategory(c)).toBe(c.startsWith('client-'))
    }
  })
})

describe('shape (c) — a category can never leak (by construction, enumerated)', () => {
  const transcript = 'OTHER PARTY (the client): We have about forty to fifty thousand budgeted for this year.'
  const raw = (scopeKind: string, category: MemoryCategory): Record<string, unknown> => ({
    scopeKind,
    category,
    statement: 'The client has a budget of $40k–$50k for the year.',
    quote: 'about forty to fifty thousand budgeted for this year',
    confidence: 0.9,
    importance: 8
  })

  it('with contact A, every client category lands in client:A exactly, category kept, no remap', () => {
    for (const category of CLIENT_CATEGORIES) {
      const out = verifyCandidate(raw('client', category), transcript, 'contact-A')
      expect('candidate' in out, category).toBe(true)
      if (!('candidate' in out)) continue
      expect(out.candidate.scope).toBe('client:contact-A')
      expect(out.candidate.category).toBe(category)
      expect(out.remappedFrom).toBeUndefined()
    }
  })
  it('the scope comes from the contact id, never from the model: contact B gives client:B for the same proposal', () => {
    for (const category of CLIENT_CATEGORIES) {
      const out = verifyCandidate(raw('client', category), transcript, 'contact-B')
      expect('candidate' in out && out.candidate.scope, category).toBe('client:contact-B')
    }
  })
  it('the reverse direction still drops: every client category claimed for the rep or the business is refused', () => {
    for (const category of CLIENT_CATEGORIES) {
      expect(resolveScopeAndCategory('rep', category, 'contact-A'), category).toEqual({ rejected: 'category-scope-mismatch' })
      expect(resolveScopeAndCategory('business', category, 'contact-A'), category).toEqual({
        rejected: 'category-scope-mismatch'
      })
    }
  })
  it('a client category with no contact is refused, never stored somewhere else', () => {
    for (const category of CLIENT_CATEGORIES) {
      expect(resolveScopeAndCategory('client', category, null), category).toEqual({ rejected: 'client-fact-without-contact' })
    }
  })
  it("shape (b)'s remap lands in the RESIDUAL, never in a named client category — the rule does not guess a topic", () => {
    const repOrBusiness = MEMORY_CATEGORIES.filter((c) => CATEGORY_SCOPE_KIND[c] !== 'client')
    for (const category of repOrBusiness) {
      const out = resolveScopeAndCategory('client', category, 'contact-A')
      expect(out, category).toEqual({ expectedKind: 'client', category: CLIENT_RESIDUAL_CATEGORY, remappedFrom: category })
    }
  })
})

describe('shape (c) — contradictions run across the whole client family', () => {
  let dir: string
  let db: Database.Database

  function candidate(scope: string, category: MemoryCategory, statement: string, callIds: string[]): MemoryCandidate {
    return {
      scope: scope as MemoryCandidate['scope'],
      category,
      statement,
      evidence: callIds.map((callId) => ({ type: 'transcript', callId, quote: statement })),
      confidence: 0.9,
      importance: 7,
      source: 'auto'
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-shape-c-'))
    db = openMemoryDb(memoryDbPath(dir))
    await migrate(db, memoryDbPath(dir))
    ai.sameFact = false
    ai.contradictsIndex = null
    ai.contradictionPrompts = []
  })
  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('a budget filed as a need is still superseded by the same budget filed as a budget', async () => {
    // the miscategorised pair: the older fact went into the wrong bucket
    const older = await consolidateNewCandidate(
      db,
      candidate('client:acme', 'client-need', 'The client has a tight budget of about $20k this year', ['call-1', 'call-2'])
    )
    expect(older).toBe('created')
    const olderId = listMemories(db, { scope: 'client:acme' })[0].id

    ai.contradictsIndex = 0 // the model recognises the change
    const newer = await consolidateNewCandidate(
      db,
      candidate('client:acme', 'client-budget', 'The client now has $60k budgeted for this year', ['call-9'])
    )
    expect(newer).toBe('created')

    // the check was MADE across categories — the prompt listed the need
    expect(ai.contradictionPrompts).toHaveLength(1)
    expect(ai.contradictionPrompts[0]).toContain('tight budget of about $20k')

    // and the older row is superseded, not deleted
    const olderRow = getMemoryById(db, olderId)
    expect(olderRow?.status).toBe('invalidated')
    expect(olderRow?.validUntil).toBeTruthy()
  })

  it('CONTROL — rep scope keeps the same-category rule: a goal is never compared against a preference', async () => {
    await consolidateNewCandidate(db, candidate('rep', 'preference', 'Prefers to send a written recap after every call', ['c1', 'c2']))
    ai.contradictsIndex = 0 // would supersede IF the check were made
    await consolidateNewCandidate(db, candidate('rep', 'stated-goal', 'Wants to close two enterprise deals this quarter', ['c3']))
    // no comparable memory in the same category → no AI call, nothing superseded
    expect(ai.contradictionPrompts).toHaveLength(0)
    const statuses = listMemories(db, { scope: 'rep' }).map((m) => m.status)
    expect(statuses.every((s) => s !== 'invalidated')).toBe(true)
  })

  it('CONTROL — the family never crosses a client boundary: acme facts are not compared against globex facts', async () => {
    await consolidateNewCandidate(db, candidate('client:acme', 'client-budget', 'Budget is $20k this year', ['c1', 'c2']))
    ai.contradictsIndex = 0
    await consolidateNewCandidate(db, candidate('client:globex', 'client-need', 'Budget is $90k this year', ['c3']))
    expect(ai.contradictionPrompts).toHaveLength(0)
    expect(listMemories(db, { scope: 'client:acme' })[0].status).not.toBe('invalidated')
  })
})
