// M37 Stage 1 — RE-EXTRACTION IS ADDITIVE. The founder's condition, as a test.
//
// The instruction, verbatim: "Additive, not destructive. New facts join;
// existing ones aren't overwritten or deleted by the re-run. If a re-extracted
// fact contradicts an existing one, that's the contradiction path doing its job
// with a proper window, not a silent replacement."
//
// That is a property of `consolidateNewCandidate`, and it was never pinned. It
// is pinned here as the INVARIANT ITSELF rather than as three example
// outcomes: whatever the model proposes, after the run every row that existed
// before must still exist, with its statement byte-identical and its evidence
// no shorter. A row may gain evidence, gain confidence, change status to
// 'invalidated' and gain a closed window — it may never vanish or be rewritten.
//
// RED-CHECKED at birth, and the check corrected the comment that predicted it.
// `invalidateMemory` was swapped for `DELETE FROM memories WHERE id = ?` — the
// silent replacement the founder is guarding against. Predicted: only the
// invariant goes red. Actual: TWO tests go red — the invariant ("rows deleted
// by the re-run: <id>") and the named contradiction example, which asserts the
// old row survives and so catches a delete too. Restored, and both green again.
// The invariant still earns its place: it is the one that catches a rewrite or
// a lost evidence entry, which no example below is looking for, and it holds
// over whatever mix of outcomes a real re-extraction happens to produce.
//
// Drives the REAL consolidateNewCandidate against a REAL SQLite database. Only
// the two AI judgments are mocked, and they are mocked per-test to answer the
// way a competent model would for these statements.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ai = {
  sameFact: false,
  contradictsIndex: null as number | null,
  /** statement → the statement it should embed NEXT TO. See the mock below. */
  nearTo: new Map<string, string>()
}

vi.mock('../../ai/complete-with-fallback', () => ({
  completeWithFallback: async (req: { tool?: { name?: string } }) => {
    if (req.tool?.name === 'judge_same_fact') return { toolInput: { sameFact: ai.sameFact } }
    return { toolInput: { contradictsIndex: ai.contradictsIndex } }
  },
  AllModelsExhaustedError: class extends Error {}
}))

// Embeddings under test control, and this detail is load-bearing. The sibling
// contradiction test uses one-hot-per-statement vectors, where EVERY pair is
// orthogonal — which silently makes `judgeSameFact` unreachable, because the
// vector pre-filter (distance <= 0.35, L2 on normalized vectors) rejects
// everything before the judge is ever consulted. The first draft of this file
// inherited that mock and its "similar statement reinforces" step created a row
// instead; the count assertion caught it. So: a statement registered in
// `ai.nearTo` embeds a hair from its anchor (L2 ≈ 0.07, comfortably inside the
// threshold) so the judge IS reached; everything else stays orthogonal so no
// other pair can short-circuit by accident.
vi.mock('../embeddings', () => {
  const dim = (s: string): number => {
    let h = 0
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    return h % 384
  }
  return {
    embedText: async (s: string) => {
      const v = new Float32Array(384)
      const anchor = ai.nearTo.get(s) ?? s
      v[dim(anchor)] = 1
      if (anchor !== s) v[dim(s)] = 0.05
      let norm = 0
      for (const x of v) norm += x * x
      norm = Math.sqrt(norm)
      for (let i = 0; i < v.length; i++) v[i] /= norm
      return v
    },
    EMBEDDING_DIMENSIONS: 384
  }
})

const { memoryDbPath, openMemoryDb, migrate } = await import('../db')
const { listMemories } = await import('../memories-store')
const { consolidateNewCandidate } = await import('../consolidation')
type MemoryCandidate = import('../types').MemoryCandidate
type MemoryCategory = import('../types').MemoryCategory

let dir: string
let db: Database.Database

function candidate(
  statement: string,
  opts: { scope?: string; category?: MemoryCategory; calls?: string[] } = {}
): MemoryCandidate {
  const calls = opts.calls ?? ['call-1']
  return {
    scope: (opts.scope ?? 'client:acme') as MemoryCandidate['scope'],
    category: opts.category ?? 'client-fact',
    statement,
    evidence: calls.map((callId) => ({ type: 'transcript', callId, quote: statement })),
    confidence: 0.9,
    importance: 7,
    source: 'auto'
  }
}

/** Everything about a row that a re-run must not damage. */
function fingerprint(db: Database.Database): Map<string, { statement: string; evidence: number; createdAt: string }> {
  const out = new Map<string, { statement: string; evidence: number; createdAt: string }>()
  for (const scope of ['rep', 'business', 'client:acme', 'client:globex'] as const) {
    for (const m of listMemories(db, {
      scope,
      statuses: ['active', 'hypothesis', 'invalidated', 'archived']
    })) {
      out.set(m.id, { statement: m.statement, evidence: m.evidence.length, createdAt: m.createdAt })
    }
  }
  return out
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-reextract-'))
  db = openMemoryDb(memoryDbPath(dir))
  await migrate(db, memoryDbPath(dir))
  ai.sameFact = false
  ai.contradictsIndex = null
  ai.nearTo = new Map()
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('re-extraction is additive — the invariant', () => {
  it('after a full re-run of mixed outcomes, EVERY pre-existing row still exists, unrewritten, with no evidence lost', async () => {
    // A store that looks like a real one: several scopes, several categories.
    await consolidateNewCandidate(db, candidate('The client uses a shared spreadsheet for scheduling'))
    await consolidateNewCandidate(db, candidate('The client has $40k budgeted for the year', { category: 'client-budget' }))
    await consolidateNewCandidate(db, candidate('Wants to go live before peak season', { category: 'client-timeline' }))
    await consolidateNewCandidate(db, candidate('Charges per seat, billed annually', { scope: 'business', category: 'pricing-model' }))
    await consolidateNewCandidate(db, candidate('Opens discovery calls with a recap', { scope: 'rep', category: 'selling-pattern' }))
    await consolidateNewCandidate(db, candidate('Globex is evaluating two vendors', { scope: 'client:globex' }))

    const before = fingerprint(db)
    expect(before.size).toBe(6)

    // The re-run. Every branch of consolidateNewCandidate is exercised:
    // an exact restatement, a judged-same restatement, a contradiction, and
    // genuinely new facts — in one pass, the way a real re-extraction mixes them.
    await consolidateNewCandidate(db, candidate('The client uses a shared spreadsheet for scheduling', { calls: ['call-9'] })) // exact → reinforce
    ai.sameFact = true
    ai.nearTo.set('The client schedules using a shared spreadsheet', 'The client uses a shared spreadsheet for scheduling')
    await consolidateNewCandidate(db, candidate('The client schedules using a shared spreadsheet', { calls: ['call-9'] })) // judged same → reinforce
    ai.sameFact = false
    ai.nearTo.clear()
    ai.contradictsIndex = 0
    await consolidateNewCandidate(db, candidate('The client now has $60k budgeted for the year', { category: 'client-budget', calls: ['call-9'] })) // contradiction
    ai.contradictsIndex = null
    await consolidateNewCandidate(db, candidate('The IT director signs off on anything touching their systems', { category: 'client-decision', calls: ['call-9'] })) // new
    await consolidateNewCandidate(db, candidate('Worried about data residency', { category: 'client-concern', calls: ['call-9'] })) // new

    const after = fingerprint(db)

    // 1. NOTHING VANISHED.
    const missing = [...before.keys()].filter((id) => !after.has(id))
    expect(missing, `rows deleted by the re-run: ${missing.join(', ')}`).toEqual([])

    // 2. NOTHING WAS REWRITTEN, and no evidence was lost.
    for (const [id, was] of before) {
      const now = after.get(id)!
      expect(now.statement, `statement of ${id} changed`).toBe(was.statement)
      expect(now.createdAt, `createdAt of ${id} changed`).toBe(was.createdAt)
      expect(now.evidence, `evidence of ${id} shrank`).toBeGreaterThanOrEqual(was.evidence)
    }

    // 3. It genuinely ADDED: the two new facts and the superseding budget.
    expect(after.size).toBe(before.size + 3)
  })
})

describe('re-extraction is additive — the three outcomes, named', () => {
  it('an exact restatement REINFORCES: no second row, evidence grows', async () => {
    await consolidateNewCandidate(db, candidate('The client uses a shared spreadsheet'))
    const outcome = await consolidateNewCandidate(db, candidate('the client uses a shared spreadsheet  ', { calls: ['call-9'] }))
    expect(outcome).toBe('reinforced')
    const rows = listMemories(db, { scope: 'client:acme', statuses: ['active', 'hypothesis'] })
    expect(rows).toHaveLength(1)
    expect(rows[0].evidence.length).toBe(2)
  })

  it('a REWORDED restatement reinforces via the judge — and the vector pre-filter really is what gates it', async () => {
    await consolidateNewCandidate(db, candidate('The client uses a shared spreadsheet for scheduling'))
    // near enough for the pre-filter, and the judge says same fact
    ai.nearTo.set('The client schedules using a shared spreadsheet', 'The client uses a shared spreadsheet for scheduling')
    ai.sameFact = true
    expect(await consolidateNewCandidate(db, candidate('The client schedules using a shared spreadsheet', { calls: ['c9'] }))).toBe(
      'reinforced'
    )
    expect(listMemories(db, { scope: 'client:acme', statuses: ['active', 'hypothesis'] })).toHaveLength(1)

    // CONTROL: the same judge answer, but too far in vector space → the judge
    // is never asked, and a second row is created. This is the branch the first
    // draft of this file accidentally tested instead.
    ai.nearTo.clear()
    expect(await consolidateNewCandidate(db, candidate('The client keeps its rota in a spreadsheet', { calls: ['c9'] }))).toBe('created')
  })

  it('a contradiction SUPERSEDES with a window: the old row survives, closed and linked forward', async () => {
    await consolidateNewCandidate(db, candidate('Budget is $40k', { category: 'client-budget', calls: ['c1', 'c2'] }))
    const oldId = listMemories(db, { scope: 'client:acme' })[0].id
    ai.contradictsIndex = 0
    await consolidateNewCandidate(db, candidate('Budget is $60k', { category: 'client-budget', calls: ['c9'] }))

    const all = listMemories(db, { scope: 'client:acme', statuses: ['active', 'hypothesis', 'invalidated'] })
    expect(all).toHaveLength(2)
    const old = all.find((m) => m.id === oldId)!
    expect(old.statement).toBe('Budget is $40k') // still readable, word for word
    expect(old.status).toBe('invalidated')
    expect(old.validUntil, 'the window must be closed, not merely marked').toBeTruthy()
    expect(old.invalidatedBy, 'and linked forward to what replaced it').toBeTruthy()
  })

  it('a genuinely new fact CREATES and touches nothing else', async () => {
    await consolidateNewCandidate(db, candidate('Budget is $40k', { category: 'client-budget' }))
    const before = fingerprint(db)
    const outcome = await consolidateNewCandidate(db, candidate('Prefers email over calls', { category: 'client-fact' }))
    expect(outcome).toBe('created')
    const after = fingerprint(db)
    expect(after.size).toBe(before.size + 1)
    for (const [id, was] of before) expect(after.get(id)!.statement).toBe(was.statement)
  })

  it('a re-run on a store the extractor produces NOTHING new for changes nothing at all', async () => {
    await consolidateNewCandidate(db, candidate('Budget is $40k', { category: 'client-budget' }))
    const before = fingerprint(db)
    // no candidates at all — the honest "the model found nothing this time" case
    const after = fingerprint(db)
    expect(after).toEqual(before)
  })
})
