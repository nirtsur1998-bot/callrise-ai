import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryDbPath, openMemoryDb, migrate } from '../db'
import { getCompiledProfile, getMemoryById, insertMemory, listMemories } from '../memories-store'
import {
  buildProfileText,
  compileProfile,
  decayMemories,
  decayedConfidence,
  distinctEpisodeCount,
  promoteHypotheses,
  runNightlyConsolidation
} from '../consolidation'
import type { Memory, MemoryCandidate, MemoryEvidence } from '../types'

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
    statement: 'Struggles when competitors are brought up mid-call',
    evidence: [transcriptEvidence('call-1')],
    confidence: 0.9,
    importance: 6,
    source: 'auto',
    ...overrides
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-consolidation-'))
  db = openMemoryDb(memoryDbPath(dir))
  await migrate(db, memoryDbPath(dir))
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

describe('distinctEpisodeCount', () => {
  it('counts one episode per distinct call, not per evidence entry', () => {
    expect(
      distinctEpisodeCount([transcriptEvidence('call-1'), transcriptEvidence('call-1'), transcriptEvidence('call-2')])
    ).toBe(2)
  })

  it('counts a reflection episode by its exact set of supporting memories', () => {
    const a: MemoryEvidence = { type: 'reflection', memoryIds: ['m1', 'm2'] }
    const b: MemoryEvidence = { type: 'reflection', memoryIds: ['m2', 'm1'] } // same set, different order
    const c: MemoryEvidence = { type: 'reflection', memoryIds: ['m1', 'm3'] } // different set
    expect(distinctEpisodeCount([a, b, c])).toBe(2) // a and b are the same episode key
  })

  it('mixes transcript and reflection episodes independently', () => {
    expect(distinctEpisodeCount([transcriptEvidence('call-1'), { type: 'reflection', memoryIds: ['m1'] }])).toBe(2)
  })

  it('returns 0 for no evidence at all', () => {
    expect(distinctEpisodeCount([])).toBe(0)
  })
})

describe('promoteHypotheses — the "one call is a hypothesis, never a fact" guardrail', () => {
  it('does NOT promote a hypothesis with only 1 or 2 distinct evidence episodes', () => {
    const m1 = insertMemory(db, candidate({ statement: 'Only seen once' }), embedding(1))
    expect(getMemoryById(db, m1.id)?.status).toBe('hypothesis')
    promoteHypotheses(db, 'rep')
    expect(getMemoryById(db, m1.id)?.status).toBe('hypothesis')

    const m2 = insertMemory(
      db,
      candidate({ statement: 'Seen twice', evidence: [transcriptEvidence('call-1'), transcriptEvidence('call-2')] }),
      embedding(2)
    )
    promoteHypotheses(db, 'rep')
    expect(getMemoryById(db, m2.id)?.status).toBe('hypothesis')
  })

  it('promotes a hypothesis to active once it has 3+ distinct evidence episodes', () => {
    const m = insertMemory(
      db,
      candidate({
        statement: 'Seen three times',
        evidence: [transcriptEvidence('call-1'), transcriptEvidence('call-2'), transcriptEvidence('call-3')]
      }),
      embedding(1)
    )
    promoteHypotheses(db, 'rep')
    expect(getMemoryById(db, m.id)?.status).toBe('active')
  })

  it('never promotes across scopes it was not asked about', () => {
    insertMemory(
      db,
      candidate({
        scope: 'business',
        category: 'pricing-model',
        statement: 'Business fact seen 3x',
        evidence: [transcriptEvidence('call-1'), transcriptEvidence('call-2'), transcriptEvidence('call-3')]
      }),
      embedding(1)
    )
    promoteHypotheses(db, 'rep') // wrong scope on purpose
    expect(listMemories(db, { scope: 'business', status: 'active' })).toHaveLength(0)
  })

  it('a user_stated memory is already active and promotion is a no-op for it', () => {
    const m = insertMemory(db, candidate({ source: 'user_stated' }), embedding(1))
    expect(getMemoryById(db, m.id)?.status).toBe('active')
    promoteHypotheses(db, 'rep')
    expect(getMemoryById(db, m.id)?.status).toBe('active')
  })
})

describe('decayedConfidence', () => {
  const now = '2026-06-01T00:00:00.000Z'

  it('never decays within the grace period', () => {
    const tenDaysAgo = '2026-05-22T00:00:00.000Z'
    expect(decayedConfidence(0.9, tenDaysAgo, now, 1)).toBe(0.9)
  })

  it('decays past the grace period', () => {
    const ninetyDaysAgo = '2026-03-03T00:00:00.000Z'
    const result = decayedConfidence(0.9, ninetyDaysAgo, now, 1)
    expect(result).toBeLessThan(0.9)
    expect(result).toBeGreaterThan(0)
  })

  it('decays more slowly with more independent evidence episodes ("survived challenge")', () => {
    const ninetyDaysAgo = '2026-03-03T00:00:00.000Z'
    const lowEvidence = decayedConfidence(0.9, ninetyDaysAgo, now, 1)
    const highEvidence = decayedConfidence(0.9, ninetyDaysAgo, now, 10)
    expect(highEvidence).toBeGreaterThan(lowEvidence)
  })

  it('never goes below 0 or above 1', () => {
    const wayInThePast = '2020-01-01T00:00:00.000Z'
    expect(decayedConfidence(0.9, wayInThePast, now, 1)).toBeGreaterThanOrEqual(0)
    expect(decayedConfidence(1.5, wayInThePast, now, 1)).toBeLessThanOrEqual(1)
  })
})

describe('decayMemories — the salience floor guardrail', () => {
  it('never decays a pinned memory, no matter how stale', () => {
    const m = insertMemory(db, candidate({ statement: 'Pinned fact' }), embedding(1))
    db.prepare('UPDATE memories SET pinned = 1, last_confirmed_at = ? WHERE id = ?').run(
      '2020-01-01T00:00:00.000Z',
      m.id
    )
    decayMemories(db, 'rep')
    const after = getMemoryById(db, m.id)
    expect(after?.confidence).toBe(m.confidence)
    expect(after?.status).toBe(m.status)
  })

  it('never decays a user_stated memory', () => {
    const m = insertMemory(db, candidate({ source: 'user_stated', statement: 'User said this' }), embedding(1))
    db.prepare('UPDATE memories SET last_confirmed_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', m.id)
    decayMemories(db, 'rep')
    expect(getMemoryById(db, m.id)?.confidence).toBe(m.confidence)
  })

  it('demotes a stale active memory to hypothesis, and archives a very stale one', () => {
    const m = insertMemory(db, candidate({ source: 'user_stated', statement: 'Will go stale' }), embedding(1))
    // force it stale enough to cross ACTIVE_DEMOTE_THRESHOLD — override
    // source to 'auto' directly in SQL so decay actually applies (can't via
    // insertMemory, which always makes user_stated active+exempt).
    db.prepare('UPDATE memories SET source = ?, last_confirmed_at = ? WHERE id = ?').run(
      'auto',
      '2020-01-01T00:00:00.000Z',
      m.id
    )
    decayMemories(db, 'rep')
    expect(getMemoryById(db, m.id)?.status).toBe('archived')
  })
})

describe('buildProfileText', () => {
  function memory(overrides: Partial<Memory> = {}): Memory {
    return {
      id: 'm',
      scope: 'rep',
      category: 'stated-struggle',
      statement: 'A fact',
      evidence: [],
      confidence: 0.8,
      importance: 5,
      status: 'active',
      source: 'auto',
      pinned: false,
      createdAt: '2026-01-01',
      lastConfirmedAt: '2026-01-01',
      ...overrides
    }
  }

  it('ranks by importance x confidence, most important first', () => {
    const low = memory({ statement: 'Low priority', importance: 2, confidence: 0.5 })
    const high = memory({ statement: 'High priority', importance: 9, confidence: 0.9 })
    const text = buildProfileText([low, high], 'standard')
    expect(text.indexOf('High priority')).toBeLessThan(text.indexOf('Low priority'))
  })

  it('never cuts a statement in the middle when hitting the budget', () => {
    const many = Array.from({ length: 50 }, (_, i) => memory({ statement: `Fact number ${i} is here`, id: `m${i}` }))
    const text = buildProfileText(many, 'micro')
    for (const line of text.split('\n')) {
      expect(line.startsWith('- Fact number')).toBe(true)
    }
  })

  it('respects the size budget ordering (micro < standard < full)', () => {
    const many = Array.from({ length: 200 }, (_, i) => memory({ statement: `Fact ${i}`, id: `m${i}` }))
    const micro = buildProfileText(many, 'micro')
    const standard = buildProfileText(many, 'standard')
    const full = buildProfileText(many, 'full')
    expect(micro.length).toBeLessThan(standard.length)
    expect(standard.length).toBeLessThan(full.length)
  })
})

describe('compileProfile', () => {
  it('only includes ACTIVE memories, never hypotheses or invalidated/archived ones', async () => {
    insertMemory(db, candidate({ source: 'user_stated', statement: 'Active fact' }), embedding(1))
    insertMemory(db, candidate({ statement: 'Hypothesis fact', evidence: [transcriptEvidence('call-x')] }), embedding(2))

    await compileProfile(db, 'rep', 'standard')
    const profile = getCompiledProfile(db, 'rep', 'standard')
    expect(profile?.text).toContain('Active fact')
    expect(profile?.text).not.toContain('Hypothesis fact')
  })

  it('produces an empty profile (not an error) when there are no active memories yet', async () => {
    await compileProfile(db, 'rep', 'micro')
    const profile = getCompiledProfile(db, 'rep', 'micro')
    expect(profile?.text).toBe('')
  })
})

describe('runNightlyConsolidation', () => {
  it('never throws on a completely empty, freshly-migrated database — the realistic first-run case', async () => {
    await expect(runNightlyConsolidation(db)).resolves.toBeUndefined()
  })

  it('decays and recompiles for every scope that has data, without needing any AI call to complete the decay/promotion/compile parts', async () => {
    insertMemory(db, candidate({ source: 'user_stated', statement: 'A rep fact' }), embedding(1))
    insertMemory(
      db,
      candidate({ scope: 'business', category: 'pricing-model', source: 'user_stated', statement: 'A business fact' }),
      embedding(2)
    )
    await runNightlyConsolidation(db)
    expect(getCompiledProfile(db, 'rep', 'standard')?.text).toContain('A rep fact')
    expect(getCompiledProfile(db, 'business', 'standard')?.text).toContain('A business fact')
  })
})
