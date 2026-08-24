// M28 Phase 2 — RETRIEVAL QUALITY EVAL. The measurement half the M27
// extraction harness never had: question → which memories SHOULD surface.
// Drives the REAL pipeline end to end — real MiniLM embeddings (local, no
// API key), a real sqlite-vec database built in a temp dir, and the real
// retrieveRelevantMemoriesStructured() — so a ranking change moves THESE
// numbers and nothing else has to be believed.
//
// Runs BOTH retrieval configurations — active-only (coaching chat today) and
// active+hypotheses (Rise) — because the delta between them is itself a
// finding.
//
// ────────────────────────────────────────────────────────────────────────────
// 2026-08-24 — LABELS, because a number without its config is a false claim.
//
// Three configurations are measured and ALL THREE describe real production
// shapes. What was wrong was which one wore the plain name "Rise":
//
//   * The row previously called "DEFAULT active+hypotheses (Rise)" supplies
//     each question's own contactId. That is a conversation ALREADY BOUND to
//     exactly the client being asked about — real, but the EXCEPTION.
//   * Rise passes `contactId: scope?.contactId ?? null` (assistant-ipc.ts:289),
//     so the default "New chat" sends null and rag.ts builds its scope list
//     WITHOUT any client scope. Every `client:*` memory is then unreachable by
//     construction. That is the DEFAULT, and it is the third row.
//
// So the headline 93% describes the exception and the 57% describes the
// default. Anyone quoting one number without saying which shape it measures is
// making a claim the harness does not support.
//
// (Superseded finding, recorded so it is not re-fixed: M28-audit-findings.md's
// C-post-bug080 says "Rise never passes contactId" and concludes real Rise
// client recall is 0 by construction. That was true when written; it is STALE
// — assistant-ipc.ts:289 passes it today. The bound row measures a shape that
// does exist; it is simply not the default one.)
// ────────────────────────────────────────────────────────────────────────────
//
// ─────────────────────────────────────────────────────────────────────────
// 2026-08-24 — THIS HARNESS WAS HOLLOW AND IS NOW A REAL GATE.
//
// As originally written its only assertions were `expect(results).toHaveLength
// (QUESTIONS.length)`, which runConfig() satisfies by construction — it pushes
// one result per question unconditionally. Proven, not theorised: reverting
// rag.ts's MAX_DISTANCE from 1.3 to 0.6 reintroduced the ENTIRE BUG-080
// regression (recall 0/14, 0%, every question answered with nothing) and this
// file still reported "Tests 1 passed", exit 0. The instrument built to
// measure BUG-080 could not detect BUG-080 returning.
//
// Two further failures of the same kind, also fixed here:
//   - The "explicit skip" for a missing embedding model asserted
//     `expect(modelUnavailable).toBeTruthy()` — i.e. it PASSED, in ~500ms,
//     having measured nothing. On any machine without the model cached (a
//     fresh clone, CI, an offline laptop) the suite went green while the
//     whole memory-quality question was silently unanswered.
//   - That same skipped run still wrote REPORT_PATH, overwriting the real
//     before/after artifact with a one-line SKIPPED. A skip that destroys
//     the evidence is worse than no harness at all.
//
// The rules now enforced below:
//   1. Scores are ASSERTED against floors, not merely printed.
//   2. A missing embedding model FAILS LOUDLY — it never reports success for
//      a run that measured nothing.
//   3. The report file is written ONLY by a run that actually measured.
// ─────────────────────────────────────────────────────────────────────────
//
// Needs the embedding model (~23MB, one-time download into a repo-local
// cache).
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
/** True only once real scores have been produced — gates the report write. */
let measured = false

/**
 * Regression floors, set just below the values measured on this machine
 * (docs/M28-retrieval-baseline.md: active-only 12/14, Rise 13/14, zero
 * violations, zero empty answers). Retrieval here is DETERMINISTIC — fixed
 * corpus, fixed questions, local MiniLM — so these are real gates, not
 * flaky thresholds. A floor rather than an equality so a genuine improvement
 * doesn't fail the build; the point is to catch a COLLAPSE.
 *
 * Calibration proof: reintroducing BUG-080 (MAX_DISTANCE 0.6) drives recall
 * to 0/14, which is far below both floors — the exact regression this file
 * exists to catch.
 */
const MIN_HITS_ACTIVE_ONLY = 11
const MIN_HITS_RISE = 12
/**
 * UNSCOPED Rise — a conversation with no client bound. This floor is
 * deliberately set at the CURRENT measured value, not an aspirational one:
 * 8/14 is a known-bad number, and the gate exists to stop it degrading
 * further while the real fix is designed.
 *
 * Why it is this low: rag.ts builds its scope list as
 * ['rep', 'business', ...(contactId ? [clientScope(contactId)] : [])], so with
 * no contactId every client:* memory is unreachable by construction. All six
 * misses are the client questions. They do not come back empty — they come
 * back with generic business memories, so Rise answers confidently from the
 * wrong context instead of saying it does not know.
 *
 * The headline 13/14 (93%) figure is measured with each question's correct
 * contactId supplied, i.e. the best case where the conversation is already
 * bound to exactly the client being asked about. Both numbers are real; they
 * describe different situations, and only this one describes "New chat".
 */
const MIN_HITS_RISE_UNSCOPED = 8
const MAX_SCOPE_VIOLATIONS = 0
const MAX_EMPTY_ANSWERS = 0
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
  // Write the report ONLY when a real measurement happened. A run that
  // measured nothing (no embedding model) must never clobber the last good
  // before/after artifact — that destruction is exactly what made the old
  // skip path worse than having no harness.
  if (measured) {
    await writeFile(REPORT_PATH, reportLines.join('\n') + '\n', 'utf8').catch(() => {})
  }
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
  maxDistance?: number,
  /**
   * Drop every question's contactId, modelling a Rise conversation that is
   * NOT bound to a client. Rise passes `scope?.contactId ?? null`
   * (assistant-ipc.ts), so this is the shape of every general conversation —
   * the default one a user gets by clicking "New chat".
   */
  unscoped = false
): Promise<QuestionResult[]> {
  const results: QuestionResult[] = []
  for (const q of QUESTIONS) {
    const retrieved = await retrieveRelevantMemoriesStructured(q.question, {
      contactId: unscoped ? null : q.contactId,
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

interface Metrics {
  totalHits: number
  totalExpected: number
  mrr: number
  violations: number
  emptyAnswers: number
  scoredCount: number
}

function report(label: string, results: QuestionResult[]): Metrics {
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
  measured = true
  return { totalHits, totalExpected, mrr, violations, emptyAnswers, scoredCount: scored.length }
}

describe('retrieval quality eval (offline, real embeddings + real sqlite-vec)', () => {
  it('baseline: active-only (coaching chat) and active+hypotheses (Rise)', async () => {
    if (modelUnavailable) {
      // FAIL LOUDLY. This used to `expect(modelUnavailable).toBeTruthy()` and
      // pass — a green run that measured nothing, on exactly the machines
      // (fresh clone, CI, offline) where a silent memory-quality regression
      // is most likely to slip through. Nothing is written to REPORT_PATH on
      // this path, so the last real before/after artifact survives.
      throw new Error(
        'Retrieval-quality harness could not run: the local embedding model is unavailable ' +
          `(${modelUnavailable}). This is a HARD FAILURE, not a skip — a green result here ` +
          'would claim memory quality was verified when nothing was measured. Run once with ' +
          'network access to populate node_modules/.cache/callrise-eval, then re-run offline.'
      )
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
    const activeMetrics = report('coaching chat — active-only, CLIENT-BOUND', activeOnly)
    const withHypotheses = await runConfig(true)
    const riseMetrics = report('Rise, CLIENT-BOUND conversation (NOT the default — see below)', withHypotheses)
    const unscopedMetrics = report(
      'Rise, UNSCOPED — *** THE DEFAULT "New chat" SHAPE ***',
      await runConfig(true, undefined, true)
    )

    // Structural sanity (kept, but it was never the real gate).
    expect(activeOnly).toHaveLength(QUESTIONS.length)
    expect(withHypotheses).toHaveLength(QUESTIONS.length)

    // THE REAL GATES. Each of these fails on a BUG-080-shaped collapse.
    expect(
      activeMetrics.totalHits,
      `active-only recall collapsed to ${activeMetrics.totalHits}/${activeMetrics.totalExpected} ` +
        `(floor ${MIN_HITS_ACTIVE_ONLY}) — see retrieval-eval-report.log`
    ).toBeGreaterThanOrEqual(MIN_HITS_ACTIVE_ONLY)
    expect(
      riseMetrics.totalHits,
      `Rise recall collapsed to ${riseMetrics.totalHits}/${riseMetrics.totalExpected} ` +
        `(floor ${MIN_HITS_RISE}) — see retrieval-eval-report.log`
    ).toBeGreaterThanOrEqual(MIN_HITS_RISE)

    // Cross-client leakage is a HARD invariant, not a score: a scoped
    // question must never surface another client's memory.
    expect(activeMetrics.violations).toBeLessThanOrEqual(MAX_SCOPE_VIOLATIONS)
    expect(riseMetrics.violations).toBeLessThanOrEqual(MAX_SCOPE_VIOLATIONS)

    // "Answered with nothing" is the user-visible symptom BUG-080 produced —
    // Rise saying "I don't know" while Memory Center visibly holds the answer.
    expect(
      riseMetrics.emptyAnswers,
      `${riseMetrics.emptyAnswers}/${riseMetrics.scoredCount} questions retrieved nothing`
    ).toBeLessThanOrEqual(MAX_EMPTY_ANSWERS)

    // The unscoped shape is the one most users are actually in. Gated at its
    // current value so a regression is caught even though the value itself is
    // not yet good enough.
    expect(
      unscopedMetrics.totalHits,
      `unscoped Rise recall dropped to ${unscopedMetrics.totalHits}/${unscopedMetrics.totalExpected} ` +
        `(floor ${MIN_HITS_RISE_UNSCOPED}) — see retrieval-eval-report.log`
    ).toBeGreaterThanOrEqual(MIN_HITS_RISE_UNSCOPED)

    // Binding a conversation to a client must never retrieve LESS than not
    // binding it. If this ever inverts, scope selection is broken.
    expect(riseMetrics.totalHits).toBeGreaterThanOrEqual(unscopedMetrics.totalHits)

    // The designed win of Rise's configuration: including hypotheses can only
    // ever surface MORE, never less, than active-only.
    expect(riseMetrics.totalHits).toBeGreaterThanOrEqual(activeMetrics.totalHits)
  }, 300_000)
})
