// M28 Phase 2 — RETRIEVAL QUALITY EVAL. The measurement half the M27
// extraction harness never had: question → which memories SHOULD surface.
// Drives the REAL pipeline end to end — real MiniLM embeddings (local, no
// API key), a real sqlite-vec database built in a temp dir, and the real
// retrieveRelevantMemoriesStructured() — so a ranking change moves THESE
// numbers and nothing else has to be believed.
//
// Like the extraction harness (memory-quality-eval.test.ts): the printed
// report is the deliverable, read by a human; the only hard assertion is
// that the pipeline didn't error. Runs BOTH retrieval configurations —
// active-only (coaching chat today) and active+hypotheses (Rise) — because
// the delta between them is itself a finding.
//
// Needs the embedding model (~23MB, one-time download into a repo-local
// cache). On a machine that can't load it (offline, no cache), the test
// SKIPS explicitly with the reason in its name — never a silent green.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { CORPUS, QUESTIONS, type EvalQuestion } from './fixtures/retrieval-eval-corpus'

const runtime = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => true }))
vi.mock('../memory-runtime', () => ({
  getMemoryDb: () => runtime.db,
  ensureMemoryDb: async () => ({ db: runtime.db, detail: 'eval' })
}))

import { configureEmbeddingsCacheDir, embedText } from '../embeddings'
import { openMemoryDb, migrate } from '../db'
import { insertMemory } from '../memories-store'
import { retrieveRelevantMemoriesStructured } from '../rag'

// Repo-local persistent cache so repeat runs never re-download the model.
configureEmbeddingsCacheDir(join(__dirname, '..', '..', '..', '..', 'node_modules', '.cache', 'callrise-eval'))

let dir: string
let db: Database.Database | null = null
let modelUnavailable: string | null = null
/** The whole report also lands in retrieval-eval-report.log at the repo root
 *  (the .log extension rides the existing gitignore/packaging exclusions) —
 *  vitest's console capture is not a reliable delivery channel, and a FILE
 *  is what a before/after comparison actually diffs. */
const reportLines: string[] = []
const REPORT_PATH = join(__dirname, '..', '..', '..', '..', 'retrieval-eval-report.log')
/** fixture key → inserted row id */
const idByKey = new Map<string, string>()
const keyById = new Map<string, string>()

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'retrieval-eval-'))
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
  for (const { key, candidate } of CORPUS) {
    const memory = insertMemory(db, candidate, await embedText(candidate.statement))
    idByKey.set(key, memory.id)
    keyById.set(memory.id, key)
  }
}, 300_000)

afterAll(async () => {
  await writeFile(REPORT_PATH, reportLines.join('\n') + '\n', 'utf8').catch(() => {})
  db?.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

interface QuestionResult {
  q: EvalQuestion
  surfacedKeys: string[]
  hits: string[]
  misses: string[]
  violations: string[]
  reciprocalRank: number
}

async function runConfig(
  includeHypotheses: boolean,
  maxDistance?: number
): Promise<QuestionResult[]> {
  const results: QuestionResult[] = []
  for (const q of QUESTIONS) {
    const retrieved = await retrieveRelevantMemoriesStructured(q.question, {
      contactId: q.contactId,
      includeHypotheses,
      maxDistance
    })
    const surfacedKeys = retrieved.map((r) => keyById.get(r.memory.id) ?? `?${r.memory.id}`)
    const hits = q.shouldSurface.filter((k) => surfacedKeys.includes(k))
    const misses = q.shouldSurface.filter((k) => !surfacedKeys.includes(k))
    const violations = (q.shouldNotSurface ?? []).filter((k) => surfacedKeys.includes(k))
    const firstRelevant = surfacedKeys.findIndex((k) => q.shouldSurface.includes(k))
    results.push({
      q,
      surfacedKeys,
      hits,
      misses,
      violations,
      reciprocalRank: firstRelevant === -1 ? 0 : 1 / (firstRelevant + 1)
    })
  }
  return results
}

function report(label: string, results: QuestionResult[]): void {
  const scored = results.filter((r) => r.q.shouldSurface.length > 0)
  const totalExpected = scored.reduce((n, r) => n + r.q.shouldSurface.length, 0)
  const totalHits = scored.reduce((n, r) => n + r.hits.length, 0)
  const mrr = scored.reduce((n, r) => n + r.reciprocalRank, 0) / scored.length
  const violations = results.reduce((n, r) => n + r.violations.length, 0)
  const emptyAnswers = scored.filter((r) => r.surfacedKeys.length === 0).length

  const lines: string[] = [`\n===== RETRIEVAL QUALITY — ${label} =====`]
  for (const r of results) {
    const status =
      r.q.shouldSurface.length === 0
        ? r.violations.length === 0
          ? 'CLEAN'
          : 'VIOLATION'
        : r.misses.length === 0
          ? 'HIT '
          : r.hits.length > 0
            ? 'PART'
            : 'MISS'
    lines.push(
      `[${status}] ${r.q.id}${r.q.needsHypotheses ? ' (hypothesis-gated)' : ''}: got [${r.surfacedKeys.join(', ') || 'nothing'}]` +
        (r.misses.length > 0 ? ` — missed [${r.misses.join(', ')}]` : '') +
        (r.violations.length > 0 ? ` — LEAKED [${r.violations.join(', ')}]` : '') +
        (r.q.note ? `  · ${r.q.note}` : '')
    )
  }
  lines.push(
    `SUMMARY ${label}: recall@5 ${totalHits}/${totalExpected} (${Math.round((totalHits / totalExpected) * 100)}%) · MRR ${mrr.toFixed(2)} · scope/relevance violations ${violations} · questions answered with nothing ${emptyAnswers}/${scored.length}`
  )
  reportLines.push(...lines)
  console.log(lines.join('\n'))
}

describe('retrieval quality eval (offline, real embeddings + real sqlite-vec)', () => {
  it('baseline: active-only (coaching chat) and active+hypotheses (Rise)', async () => {
    if (modelUnavailable) {
      reportLines.push(`SKIPPED — embedding model unavailable: ${modelUnavailable}`)
      console.log(reportLines[reportLines.length - 1])
      expect(modelUnavailable).toBeTruthy() // explicit, documented skip
      return
    }
    // Threshold sweep (L2, unit vectors) — the operating-point picker for
    // rag.ts's MAX_DISTANCE. 0.6 is the pre-M28 shipped value.
    for (const maxDistance of [0.6, 1.0, 1.1, 1.2, 1.25, 1.3, 1.4]) {
      report(
        `sweep maxDistance=${maxDistance} (active+hypotheses)`,
        await runConfig(true, maxDistance)
      )
    }
    const activeOnly = await runConfig(false)
    report('DEFAULT active-only (coaching chat)', activeOnly)
    const withHypotheses = await runConfig(true)
    report('DEFAULT active+hypotheses (Rise)', withHypotheses)

    // The one hard functional assertion: the pipeline ran for every question
    // in both configs without erroring. Scores are the human-read deliverable.
    expect(activeOnly).toHaveLength(QUESTIONS.length)
    expect(withHypotheses).toHaveLength(QUESTIONS.length)
  }, 300_000)
})
