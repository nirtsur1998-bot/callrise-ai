// M36 Stage 3 item 5, step 3 — THE DATED FIXTURE. The founder's condition:
// "at least one question where the current answer and the as-of answer
// genuinely differ. That's the only case that proves the feature does
// anything — ten questions that return the same thing either way would
// pass and mean nothing." This file asserts that difference, per question
// and in aggregate, on the real pipeline: real MiniLM, real sqlite-vec, real
// FTS5, real invalidateMemory closing real windows.
//
// The timeline (one client, one business fact; all dates are event time):
//   budget    $40k from MARCH ─── superseded JULY ──▶ $55k from JULY
//   decision  Dana  from FEB   ─── superseded AUG  ──▶ Priya from AUG
//   tool      FleetPilot from APRIL, never superseded (still true)
//   pilot     wants a pilot, dated MAY but APPROXIMATE (learning time)
//   pricing   $49/seat from JAN ─── superseded SEP 1 ──▶ $59/seat
//
// Same fail-loud rule as retrieval-quality-eval.test.ts: no model, no green.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'

const runtime = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => true }))
vi.mock('../memory-runtime', () => ({
  getMemoryDb: () => runtime.db,
  ensureMemoryDb: async () => ({ db: runtime.db, detail: 'eval' })
}))

import { configureEmbeddingsCacheDir, embedText } from '../embeddings'
import { openMemoryDb, migrate } from '../db'
import { insertMemory, invalidateMemory, setValidity } from '../memories-store'
import { retrieveRelevantMemoriesStructured } from '../rag'
import type { MemoryCandidate, MemoryScope } from '../types'

configureEmbeddingsCacheDir(join(__dirname, '..', '..', '..', '..', 'node_modules', '.cache', 'callrise-eval'))

const JAN = '2026-01-10T09:00:00.000Z'
const FEB = '2026-02-05T09:00:00.000Z'
const MARCH = '2026-03-14T10:00:00.000Z'
const APRIL = '2026-04-20T10:00:00.000Z'
const MAY = '2026-05-12T10:00:00.000Z'
const JULY = '2026-07-02T15:30:00.000Z'
const AUG = '2026-08-18T11:00:00.000Z'
const SEP1 = '2026-09-01T08:00:00.000Z'

interface Fact {
  key: string
  scope: MemoryScope
  statement: string
  /** event time; undefined = inserted without `at` (born approximate) */
  at?: string
  supersedes?: string
}
const FACTS: Fact[] = [
  { key: 'budget-40k', scope: 'client:eval-acme', statement: 'Budget ceiling is around 40000 dollars for this year', at: MARCH },
  { key: 'budget-55k', scope: 'client:eval-acme', statement: 'Budget ceiling was raised to 55000 dollars after the board review', at: JULY, supersedes: 'budget-40k' },
  { key: 'dm-dana', scope: 'client:eval-acme', statement: 'Decision maker is Dana Levy, VP of Operations', at: FEB },
  { key: 'dm-priya', scope: 'client:eval-acme', statement: 'Decision maker is now Priya Nandakumar, the COO', at: AUG, supersedes: 'dm-dana' },
  { key: 'tool-fleetpilot', scope: 'client:eval-acme', statement: 'Currently using FleetPilot and unhappy with support response times', at: APRIL },
  { key: 'pilot-first', scope: 'client:eval-acme', statement: 'Wants a pilot phase before committing to an annual contract' }, // approx, set to MAY below
  { key: 'pricing-49', scope: 'business', statement: 'Pricing is per seat at 49 dollars a month with a 20 percent annual discount', at: JAN },
  { key: 'pricing-59', scope: 'business', statement: 'Pricing is per seat at 59 dollars a month since the September price change', at: SEP1, supersedes: 'pricing-49' },
  // distractors, current
  { key: 'd-icp', scope: 'business', statement: 'Ideal customers are mid-market logistics companies with 50 to 500 employees', at: JAN },
  { key: 'd-friday', scope: 'client:eval-acme', statement: 'The office closes at four on Fridays, so no late calls that day', at: APRIL }
]

interface TemporalQuestion {
  id: string
  question: string
  asOf?: string
  shouldSurface: string[]
  shouldNotSurface: string[]
  note: string
}
const QUESTIONS: TemporalQuestion[] = [
  { id: 'budget-now', question: 'What is their budget?', shouldSurface: ['budget-55k'], shouldNotSurface: ['budget-40k'], note: 'untimed: the current fact, never the superseded one' },
  { id: 'budget-june', question: 'What is their budget?', asOf: '2026-06-15T00:00:00.000Z', shouldSurface: ['budget-40k'], shouldNotSurface: ['budget-55k'], note: 'DIFFERS: June is inside the $40k window, before the July raise' },
  { id: 'budget-august', question: 'What is their budget?', asOf: '2026-08-01T00:00:00.000Z', shouldSurface: ['budget-55k'], shouldNotSurface: ['budget-40k'], note: 'as-of after the raise: same as now' },
  { id: 'budget-before-known', question: 'What is their budget?', asOf: '2026-02-01T00:00:00.000Z', shouldSurface: [], shouldNotSurface: ['budget-40k', 'budget-55k'], note: 'DIFFERS: before the earliest budget fact — nothing, the refusal case (earliest is March)' },
  { id: 'dm-now', question: 'Who makes the buying decisions?', shouldSurface: ['dm-priya'], shouldNotSurface: ['dm-dana'], note: 'untimed' },
  { id: 'dm-may', question: 'Who makes the buying decisions?', asOf: '2026-05-01T00:00:00.000Z', shouldSurface: ['dm-dana'], shouldNotSurface: ['dm-priya'], note: 'DIFFERS: Dana until August' },
  { id: 'dm-today', question: 'Who makes the buying decisions?', asOf: '2026-09-06T12:00:00.000Z', shouldSurface: ['dm-priya'], shouldNotSurface: ['dm-dana'], note: 'as-of today equals now' },
  { id: 'tool-june', question: 'Why is Acme unhappy with the tool they use today?', asOf: '2026-06-01T00:00:00.000Z', shouldSurface: ['tool-fleetpilot'], shouldNotSurface: [], note: 'never superseded: same either way' },
  { id: 'tool-march', question: 'Why is Acme unhappy with the tool they use today?', asOf: '2026-03-01T00:00:00.000Z', shouldSurface: [], shouldNotSurface: ['tool-fleetpilot'], note: 'DIFFERS: before April, the fact was not yet known to be true' },
  { id: 'pilot-june', question: 'Do they want a pilot before signing?', asOf: '2026-06-01T00:00:00.000Z', shouldSurface: ['pilot-first'], shouldNotSurface: [], note: 'approximate May date, inside range — surfaces (the answer layer shows the marker)' },
  { id: 'pilot-april', question: 'Do they want a pilot before signing?', asOf: '2026-04-15T00:00:00.000Z', shouldSurface: [], shouldNotSurface: ['pilot-first'], note: 'DIFFERS: an approximate date filters like a real one; it is the MARKER that says it may be wrong' },
  { id: 'pricing-now', question: 'What do we charge per seat?', shouldSurface: ['pricing-59'], shouldNotSurface: ['pricing-49'], note: 'untimed' },
  { id: 'pricing-june', question: 'What do we charge per seat?', asOf: '2026-06-01T00:00:00.000Z', shouldSurface: ['pricing-49'], shouldNotSurface: ['pricing-59'], note: 'DIFFERS: business scope, the old price' }
]

let dir: string
let db: Database.Database | null = null
let modelUnavailable: string | null = null
const idByKey = new Map<string, string>()
const keyById = new Map<string, string>()
const reportLines: string[] = []
const REPORT_PATH = join(__dirname, '..', '..', '..', '..', 'retrieval-eval-temporal-report.log')
let measured = false

function candidate(f: Fact): MemoryCandidate {
  return {
    scope: f.scope,
    category: f.scope === 'business' ? 'pricing-model' : 'client-fact',
    statement: f.statement,
    evidence: [{ type: 'transcript', callId: `eval-call-${f.key}`, quote: f.statement, ...(f.at ? { at: f.at } : {}) }],
    confidence: 0.9,
    importance: 6,
    source: 'user_confirmed'
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retrieval-eval-temporal-'))
  try {
    await embedText('warm up the model')
  } catch (err) {
    modelUnavailable = err instanceof Error ? err.message : String(err)
    return
  }
  const dbPath = join(dir, 'memory.db')
  db = openMemoryDb(dbPath)
  const migrated = await migrate(db, dbPath)
  if (!migrated.ok) throw new Error(`migrate failed: ${JSON.stringify(migrated)}`)
  runtime.db = db
  for (const f of FACTS) {
    const m = insertMemory(db, candidate(f), await embedText(f.statement))
    idByKey.set(f.key, m.id)
    keyById.set(m.id, f.key)
  }
  // the pilot fact: born 'stated' at the learning moment (today); make it the
  // shape the backfill produces for an old row with no recoverable call —
  // an APPROXIMATE May date
  setValidity(db, idByKey.get('pilot-first')!, { validFrom: MAY, validFromSource: 'approx' })
  // real supersession: the window closes at the superseder's valid_from
  for (const f of FACTS) {
    if (f.supersedes) invalidateMemory(db, idByKey.get(f.supersedes)!, idByKey.get(f.key)!)
  }
}, 300_000)

afterAll(async () => {
  if (measured) await writeFile(REPORT_PATH, reportLines.join('\n') + '\n', 'utf8').catch(() => {})
  db?.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('temporal retrieval eval (offline, real embeddings + real sqlite-vec + real windows)', () => {
  it('as-of questions answer from the fact valid at that moment; untimed questions are untouched', async () => {
    if (modelUnavailable) {
      throw new Error(
        `Temporal retrieval harness could not run: the local embedding model is unavailable (${modelUnavailable}). HARD FAILURE, not a skip.`
      )
    }
    const lines: string[] = ['\n===== TEMPORAL RETRIEVAL — as-of vs untimed, client-bound Rise =====']
    let hits = 0
    let expected = 0
    let violations = 0
    let differing = 0
    let untimedLeaks = 0
    const failures: string[] = []
    for (const q of QUESTIONS) {
      const contactId = 'eval-acme'
      const timed = await retrieveRelevantMemoriesStructured(q.question, { contactId, includeHypotheses: true, asOf: q.asOf })
      const untimed = await retrieveRelevantMemoriesStructured(q.question, { contactId, includeHypotheses: true })
      const got = timed.map((r) => keyById.get(r.memory.id) ?? '?')
      const gotUntimed = untimed.map((r) => keyById.get(r.memory.id) ?? '?')
      const h = q.shouldSurface.filter((k) => got.includes(k))
      const v = q.shouldNotSurface.filter((k) => got.includes(k))
      hits += h.length
      expected += q.shouldSurface.length
      violations += v.length
      // an untimed answer must never carry a superseded fact
      untimedLeaks += untimed.filter((r) => r.memory.status === 'invalidated').length
      const differs = q.asOf !== undefined && got.join(',') !== gotUntimed.join(',')
      if (differs) differing++
      const status = q.shouldSurface.length === 0 ? (v.length ? 'VIOLATION' : 'CLEAN') : h.length === q.shouldSurface.length && v.length === 0 ? 'HIT ' : 'MISS'
      lines.push(
        `[${status}] ${q.id}${q.asOf ? ` as of ${q.asOf.slice(0, 10)}` : ' (untimed)'}: got [${got.join(', ') || 'nothing'}]` +
          (q.asOf ? ` · untimed would give [${gotUntimed.join(', ') || 'nothing'}]${differs ? ' — DIFFERS' : ' — same'}` : '') +
          (v.length ? ` — LEAKED [${v.join(', ')}]` : '') +
          `  · ${q.note}`
      )
      // per-question failures are COLLECTED so the whole report prints before
      // the first one fails the run — a harness that dies on question 8
      // hides questions 9–13
      if (h.length !== q.shouldSurface.length) failures.push(`${q.id}: expected [${q.shouldSurface.join(',')}] got [${got.join(',')}]`)
      if (v.length) failures.push(`${q.id}: leaked [${v.join(',')}]`)
      // every result of a timed question sits inside its window
      for (const r of timed) {
        if (q.asOf) {
          if (r.memory.validFrom && !(r.memory.validFrom <= q.asOf)) failures.push(`${q.id}: ${keyById.get(r.memory.id)} not yet true at ${q.asOf}`)
          if (r.memory.validUntil && !(r.memory.validUntil > q.asOf)) failures.push(`${q.id}: ${keyById.get(r.memory.id)} already over at ${q.asOf}`)
        }
      }
    }
    const timedCount = QUESTIONS.filter((q) => q.asOf).length
    lines.push(
      `SUMMARY temporal: recall ${hits}/${expected} · violations ${violations} · as-of questions whose answer DIFFERS from untimed ${differing}/${timedCount} · superseded facts in untimed answers ${untimedLeaks}`
    )
    reportLines.push(...lines)
    console.log(lines.join('\n'))
    measured = true

    expect(failures, failures.join('\n')).toEqual([])
    expect(violations).toBe(0)
    expect(untimedLeaks).toBe(0)
    expect(hits).toBe(expected)
    // THE assertion the founder asked for: the feature must be seen to do something
    expect(differing, 'no as-of answer differed from the untimed one — the feature did nothing').toBeGreaterThanOrEqual(5)
  }, 300_000)
})
