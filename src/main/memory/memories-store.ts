// M25 Sales Brain — reads/writes on the `memories` + `vec_memories` tables.
// The only module that touches SQL directly for memory records (mirrors
// this codebase's *-fs.ts convention: one module owns a store's on-disk
// shape, everything else goes through its functions).
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type {
  CompiledProfile,
  Memory,
  MemoryCandidate,
  MemoryEvidence,
  MemoryScope,
  MemoryStatus,
  ProfileSize,
  ValidityDateSource
} from './types'
import { ftsMatchQuery, matchedTerms } from './lexical-terms'

interface MemoryRow {
  rowid_pk: number
  id: string
  scope: string
  category: string
  statement: string
  evidence: string
  confidence: number
  importance: number
  status: string
  source: string
  pinned: number
  invalidated_by: string | null
  created_at: string
  last_confirmed_at: string
  last_retrieved_at?: string | null
  invalidated_at: string | null
  valid_from?: string | null
  valid_from_source?: string | null
  valid_until?: string | null
  valid_until_source?: string | null
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    category: row.category as Memory['category'],
    statement: row.statement,
    evidence: JSON.parse(row.evidence) as MemoryEvidence[],
    confidence: row.confidence,
    importance: row.importance,
    status: row.status as MemoryStatus,
    source: row.source as Memory['source'],
    pinned: row.pinned === 1,
    invalidatedBy: row.invalidated_by ?? undefined,
    createdAt: row.created_at,
    lastConfirmedAt: row.last_confirmed_at,
    lastRetrievedAt: row.last_retrieved_at ?? undefined,
    invalidatedAt: row.invalidated_at ?? undefined,
    validFrom: row.valid_from ?? undefined,
    validFromSource: (row.valid_from_source as ValidityDateSource | null | undefined) ?? undefined,
    validUntil: row.valid_until ?? undefined,
    validUntilSource: (row.valid_until_source as ValidityDateSource | null | undefined) ?? undefined
  }
}

/**
 * M36 Stage 3 item 5 — the validity a NEW memory is born with. Event time
 * first: the earliest `at` its transcript evidence carries (the call's own
 * start). Failing that, a fact the user stated or confirmed themselves is
 * exact at the moment they said it ('stated'). Failing both, the learning
 * time stands in, marked 'approx' so nothing downstream mistakes it for a
 * real date. Pure, so the rule is testable without a db.
 */
export function validityAtInsert(
  candidate: Pick<MemoryCandidate, 'evidence' | 'source'>,
  createdAtIso: string
): { validFrom: string; validFromSource: ValidityDateSource } {
  const eventTimes = candidate.evidence
    .flatMap((e) => (e.type === 'transcript' && e.at && !Number.isNaN(Date.parse(e.at)) ? [e.at] : []))
    .sort()
  if (eventTimes.length > 0) return { validFrom: eventTimes[0], validFromSource: 'call' }
  if (candidate.source === 'user_stated' || candidate.source === 'user_confirmed') {
    return { validFrom: createdAtIso, validFromSource: 'stated' }
  }
  return { validFrom: createdAtIso, validFromSource: 'approx' }
}

/** Sets either or both validity bounds with their sources. Used by the
 *  temporal backfill and by consolidation when a contradiction closes a
 *  fact's window. Only the fields given are written. */
export function setValidity(
  db: Database.Database,
  id: string,
  validity: {
    validFrom?: string | null
    validFromSource?: ValidityDateSource | null
    validUntil?: string | null
    validUntilSource?: ValidityDateSource | null
  }
): void {
  const sets: string[] = []
  const params: Record<string, string | null> = { id }
  if ('validFrom' in validity) {
    sets.push('valid_from = @validFrom', 'valid_from_source = @validFromSource')
    params.validFrom = validity.validFrom ?? null
    params.validFromSource = validity.validFromSource ?? null
  }
  if ('validUntil' in validity) {
    sets.push('valid_until = @validUntil', 'valid_until_source = @validUntilSource')
    params.validUntil = validity.validUntil ?? null
    params.validUntilSource = validity.validUntilSource ?? null
  }
  if (sets.length === 0) return
  db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = @id`).run(params)
}

/** `memory_meta` (migration 6): small key/value facts about the store itself
 *  — the temporal backfill's record lives here so its counts can be shown,
 *  and so it never runs twice. */
export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}
export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)').run(key, value)
}

/**
 * M36 Stage 3 item 4 — the retriever surfaced these memories: record it, so
 * decay can tell a fact in weekly use from one nobody has touched. Only
 * moves forward (an older timestamp never rewinds a newer one); an empty
 * list is a no-op; never throws into the retrieval path.
 */
export function touchRetrieved(db: Database.Database, ids: ReadonlyArray<string>, nowIso: string): void {
  if (ids.length === 0) return
  const stmt = db.prepare(
    'UPDATE memories SET last_retrieved_at = ? WHERE id = ? AND (last_retrieved_at IS NULL OR last_retrieved_at < ?)'
  )
  const run = db.transaction((list: ReadonlyArray<string>) => {
    for (const id of list) stmt.run(nowIso, id, nowIso)
  })
  run(ids)
}

/** A directly user-confirmed/stated fact is trusted immediately (the user
 *  IS the evidence). An auto-extracted one starts as a hypothesis — spec
 *  section 2's promotion rule ("a pattern seen in 3+ calls becomes a
 *  durable fact... one call is a hypothesis, never a fact") is Phase 2's
 *  consolidation engine's job to apply; this is just the correct starting
 *  point for it to promote FROM. */
function initialStatus(source: MemoryCandidate['source']): MemoryStatus {
  return source === 'auto' ? 'hypothesis' : 'active'
}

function toBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
}

/** Inserts a new memory + its embedding as one atomic unit — a memory row
 *  with no matching vec_memories row (or vice versa) would silently break
 *  every vector search that should have found it, so these two tables are
 *  never written independently. */
export function insertMemory(
  db: Database.Database,
  candidate: MemoryCandidate,
  embedding: Float32Array
): Memory {
  const now = new Date().toISOString()
  const memory: Memory = {
    id: randomUUID(),
    scope: candidate.scope,
    category: candidate.category,
    statement: candidate.statement,
    evidence: candidate.evidence,
    confidence: candidate.confidence,
    importance: candidate.importance,
    status: initialStatus(candidate.source),
    source: candidate.source,
    pinned: false,
    createdAt: now,
    lastConfirmedAt: now,
    ...validityAtInsert(candidate, now)
  }

  const insertMemoryStmt = db.prepare(`
    INSERT INTO memories
      (id, scope, category, statement, evidence, confidence, importance, status, source, pinned, created_at, last_confirmed_at, valid_from, valid_from_source)
    VALUES (@id, @scope, @category, @statement, @evidence, @confidence, @importance, @status, @source, @pinned, @createdAt, @lastConfirmedAt, @validFrom, @validFromSource)
  `)
  const insertVecStmt = db.prepare('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)')

  const runBoth = db.transaction(() => {
    const info = insertMemoryStmt.run({
      id: memory.id,
      scope: memory.scope,
      category: memory.category,
      statement: memory.statement,
      evidence: JSON.stringify(memory.evidence),
      confidence: memory.confidence,
      importance: memory.importance,
      status: memory.status,
      source: memory.source,
      pinned: 0,
      createdAt: memory.createdAt,
      lastConfirmedAt: memory.lastConfirmedAt,
      validFrom: memory.validFrom ?? null,
      validFromSource: memory.validFromSource ?? null
    })
    // vec0 quirk (confirmed empirically, see db.ts's sibling module doc
    // comments / the Phase 1 checkpoint write-up): a bound rowid parameter
    // MUST be a BigInt, or better-sqlite3/sqlite-vec rejects it with "Only
    // integers are allows for primary key values" even though the value
    // genuinely is an integer.
    insertVecStmt.run(BigInt(info.lastInsertRowid as number), toBlob(embedding))
  })
  runBoth()

  return memory
}

export function getMemoryById(db: Database.Database, id: string): Memory | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
  return row ? rowToMemory(row) : null
}

export interface ListMemoriesOptions {
  scope?: MemoryScope
  status?: MemoryStatus
  /** OR'd against `status` when both are absent from a call — lets a
   *  consolidation pass fetch "active + hypothesis" in one query instead of
   *  two. Phase 2 addition; Phase 1's single-status filter still works
   *  unchanged for existing callers. */
  statuses?: MemoryStatus[]
  category?: Memory['category']
}

/** Plain structured lookup — no vector search. Used for scope-browsing (the
 *  Memory Center UI, Phase 5) and for anywhere a caller already knows
 *  exactly which scope/category it wants rather than an open-ended query. */
export function listMemories(db: Database.Database, opts: ListMemoriesOptions = {}): Memory[] {
  const clauses: string[] = []
  const params: Record<string, string> = {}
  if (opts.scope) {
    clauses.push('scope = @scope')
    params.scope = opts.scope
  }
  if (opts.status) {
    clauses.push('status = @status')
    params.status = opts.status
  } else if (opts.statuses?.length) {
    clauses.push(`status IN (${opts.statuses.map((_, i) => `@status${i}`).join(', ')})`)
    opts.statuses.forEach((s, i) => {
      params[`status${i}`] = s
    })
  }
  if (opts.category) {
    clauses.push('category = @category')
    params.category = opts.category
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC`).all(params) as MemoryRow[]
  return rows.map(rowToMemory)
}

/** Every distinct scope with at least one memory — the nightly consolidation
 *  pass (consolidation.ts's runNightlyConsolidation()) iterates this to
 *  cover every rep/business/client scope that actually has data, rather
 *  than needing a separate registry of "which scopes exist." */
export function listDistinctScopes(db: Database.Database): MemoryScope[] {
  const rows = db.prepare('SELECT DISTINCT scope FROM memories').all() as { scope: string }[]
  return rows.map((r) => r.scope as MemoryScope)
}

export interface VectorSearchResult {
  memory: Memory
  /** L2 distance between the question's embedding and this memory's — REAL
   *  on every result, including ones the lexical channel surfaced (they
   *  carry the distance the vector channel would have given them, which is
   *  usually why the vector channel missed them). */
  distance: number
  /** M36 Stage 3 item 2 — which channel(s) surfaced this result. Absent on
   *  raw store results; set by rag.ts's fusion. */
  via?: 'vector' | 'lexical' | 'both'
  /** The question's terms this statement contains, when the lexical channel
   *  had a say — so a citation can show WHY ("matched: okafor"). */
  matchedTerms?: string[]
}

export interface LexicalSearchResult extends VectorSearchResult {
  /** FTS5 bm25() — lower is better, always ≤ 0. */
  score: number
  matchedTerms: string[]
}

/**
 * M36 Stage 3 item 2 — the lexical channel (hybrid retrieval's other half).
 * Matches ANY of `terms` against `memories_fts` (migration 5), ranked by
 * bm25, with the same status and scope filters as the vector search so the
 * cross-scope invariant in rag.ts holds for both channels identically. Each
 * row also carries its TRUE vector distance from `queryEmbedding` — a lexical
 * hit is never given a made-up distance. `terms` come from
 * lexical-terms.ts; an empty list returns [] without touching the db.
 */
export function searchMemoriesByText(
  db: Database.Database,
  terms: ReadonlyArray<string>,
  queryEmbedding: Float32Array,
  opts: { scope?: MemoryScope; limit?: number; statuses?: MemoryStatus[] } = {}
): LexicalSearchResult[] {
  if (terms.length === 0) return []
  const limit = opts.limit ?? 10
  const statuses = opts.statuses?.length ? opts.statuses : (['active'] as MemoryStatus[])
  const statusParams: Record<string, string> = {}
  statuses.forEach((s, i) => {
    statusParams[`status${i}`] = s
  })
  const rows = db
    .prepare(
      `
      SELECT m.*, bm25(memories_fts) AS score, vec_distance_L2(v.embedding, @embedding) AS distance
      FROM memories_fts f
      JOIN memories m ON m.rowid_pk = f.rowid
      JOIN vec_memories v ON v.rowid = m.rowid_pk
      WHERE memories_fts MATCH @match
        AND m.status IN (${statuses.map((_, i) => `@status${i}`).join(', ')})
        ${opts.scope ? 'AND m.scope = @scope' : ''}
      ORDER BY bm25(memories_fts)
      LIMIT @limit
      `
    )
    .all({
      match: ftsMatchQuery(terms),
      embedding: toBlob(queryEmbedding),
      limit,
      ...statusParams,
      ...(opts.scope ? { scope: opts.scope } : {})
    }) as (MemoryRow & { score: number; distance: number })[]

  return rows.map((row) => ({
    memory: rowToMemory(row),
    distance: row.distance,
    score: row.score,
    matchedTerms: matchedTerms(row.statement, terms)
  }))
}

/** Hybrid-retrieval's vector half (spec section 2's RETRIEVE step) — ranking
 *  by relevance × recency × importance is Phase 4's job once there's a real
 *  consumer (coaching chat RAG); this returns raw nearest-neighbor results
 *  only. Defaults to active-only (a hypothesis or an invalidated/archived
 *  fact should never surface in a normal retrieval result — spec section 5:
 *  "Invalidated memories are never asserted") — `statuses` lets
 *  consolidation.ts's dedupe search widen this to active+hypothesis, since
 *  a new candidate needs to be checked against BOTH before deciding it's
 *  genuinely new. */
export function searchMemoriesByVector(
  db: Database.Database,
  queryEmbedding: Float32Array,
  opts: { scope?: MemoryScope; limit?: number; statuses?: MemoryStatus[] } = {}
): VectorSearchResult[] {
  const limit = opts.limit ?? 10
  const statuses = opts.statuses?.length ? opts.statuses : (['active'] as MemoryStatus[])
  const statusParams: Record<string, string> = {}
  statuses.forEach((s, i) => {
    statusParams[`status${i}`] = s
  })
  const rows = db
    .prepare(
      `
      SELECT m.*, v.distance AS distance
      FROM vec_memories v
      JOIN memories m ON m.rowid_pk = v.rowid
      WHERE v.embedding MATCH @embedding AND k = @limit
        AND m.status IN (${statuses.map((_, i) => `@status${i}`).join(', ')})
        ${opts.scope ? 'AND m.scope = @scope' : ''}
      ORDER BY v.distance
      `
    )
    .all({
      embedding: toBlob(queryEmbedding),
      limit,
      ...statusParams,
      ...(opts.scope ? { scope: opts.scope } : {})
    }) as (MemoryRow & { distance: number })[]

  return rows.map((row) => ({ memory: rowToMemory(row), distance: row.distance }))
}

/** Same-fact reinforcement (spec section 2's CONSOLIDATE step: "same fact
 *  restated → reinforce... NEVER re-summarize existing memories into new
 *  summaries repeatedly"). Phase 1 doesn't run consolidation yet, but this
 *  primitive is needed by extraction.ts's own duplicate-within-one-call
 *  guard (never insert the exact same statement twice from one extraction
 *  pass) — the real cross-call dedupe/merge logic is Phase 2's. */
export function reinforceMemory(db: Database.Database, id: string, evidence: MemoryEvidence): Memory | null {
  const existing = getMemoryById(db, id)
  if (!existing) return null
  const now = new Date().toISOString()
  const nextEvidence = [...existing.evidence, evidence]
  db.prepare('UPDATE memories SET evidence = ?, last_confirmed_at = ? WHERE id = ?').run(
    JSON.stringify(nextEvidence),
    now,
    id
  )
  return { ...existing, evidence: nextEvidence, lastConfirmedAt: now }
}

/** Episodic→semantic promotion (spec section 2): a hypothesis becomes a
 *  trusted, assertable fact. Only ever moves 'hypothesis' -> 'active' — a
 *  no-op (not an error) on any other current status, since the caller
 *  (consolidation.ts's promoteHypotheses()) only ever calls this after
 *  already checking the status itself; this is a second, cheap guard
 *  against a stale read racing a concurrent status change. */
export function promoteToActive(db: Database.Database, id: string): Memory | null {
  const existing = getMemoryById(db, id)
  if (!existing || existing.status !== 'hypothesis') return existing
  db.prepare("UPDATE memories SET status = 'active' WHERE id = ?").run(id)
  return { ...existing, status: 'active' }
}

/** Contradiction handling (spec section 2, Zep-style): the OLD memory is
 *  never deleted, only temporally invalidated — `invalidatedBy` links
 *  forward to whichever new memory superseded it, so the history stays
 *  fully viewable (spec section 4's Memory Center changelog, Phase 5). */
export function invalidateMemory(db: Database.Database, id: string, supersededByMemoryId: string): Memory | null {
  const existing = getMemoryById(db, id)
  if (!existing) return null
  const now = new Date().toISOString()
  db.prepare("UPDATE memories SET status = 'invalidated', invalidated_at = ?, invalidated_by = ? WHERE id = ?").run(
    now,
    supersededByMemoryId,
    id
  )
  return { ...existing, status: 'invalidated', invalidatedAt: now, invalidatedBy: supersededByMemoryId }
}

/** Decay (spec section 2, nightly): confidence drifts down without
 *  reconfirming evidence. Never touches status by itself — the caller
 *  (consolidation.ts's decayMemories()) decides the active->hypothesis and
 *  hypothesis->archived transitions based on the NEW confidence value this
 *  returns, keeping the "what confidence means what status" threshold
 *  logic in one place (consolidation.ts) rather than duplicated here. */
export function updateConfidence(db: Database.Database, id: string, confidence: number): Memory | null {
  const existing = getMemoryById(db, id)
  if (!existing) return null
  const clamped = Math.max(0, Math.min(1, confidence))
  db.prepare('UPDATE memories SET confidence = ? WHERE id = ?').run(clamped, id)
  return { ...existing, confidence: clamped }
}

/** Demotes a memory's status directly — used by decayMemories() for both
 *  the active->hypothesis and hypothesis->archived transitions. Unlike
 *  promoteToActive(), this has no single fixed "from" status: decay can
 *  demote from either active or hypothesis depending on how far confidence
 *  has fallen, so the caller passes the exact target rather than this
 *  function inferring it. */
export function setMemoryStatus(db: Database.Database, id: string, status: MemoryStatus): Memory | null {
  const existing = getMemoryById(db, id)
  if (!existing) return null
  db.prepare('UPDATE memories SET status = ? WHERE id = ?').run(status, id)
  return { ...existing, status }
}

/** L4 working-memory storage (spec section 1) — one row per (scope, size),
 *  always a full replace (a profile is regenerated whole, never patched —
 *  see consolidation.ts's compileProfile()). */
export function upsertCompiledProfile(db: Database.Database, profile: CompiledProfile): void {
  db.prepare(
    `
    INSERT INTO compiled_profiles (scope, size, text, generated_at)
    VALUES (@scope, @size, @text, @generatedAt)
    ON CONFLICT (scope, size) DO UPDATE SET text = @text, generated_at = @generatedAt
    `
  ).run({ scope: profile.scope, size: profile.size, text: profile.text, generatedAt: profile.generatedAt })
}

export function getCompiledProfile(
  db: Database.Database,
  scope: MemoryScope,
  size: ProfileSize
): CompiledProfile | null {
  const row = db
    .prepare('SELECT * FROM compiled_profiles WHERE scope = ? AND size = ?')
    .get(scope, size) as { scope: string; size: string; text: string; generated_at: string } | undefined
  if (!row) return null
  return { scope: row.scope as MemoryScope, size: row.size as ProfileSize, text: row.text, generatedAt: row.generated_at }
}

// --- Phase 5: Memory Center — direct rep edits ------------------------------
// The trust UI's controls (spec section 4). Every one of these is a
// deliberate USER action, not a consolidation-engine decision — so unlike
// promoteToActive/invalidateMemory/setMemoryStatus above (which are called
// by consolidation.ts's own judgment), these are called directly by
// memory-center-ipc.ts in response to a click.

/** A rep-edited statement is, by definition, correct — re-embedding is the
 *  caller's job (memory-center-ipc.ts), since embedding requires the
 *  async model and this module stays synchronous. Also bumps confidence to
 *  1 and status to 'active': an edit IS a confirmation, the same way
 *  reinforcement works, just via direct rewrite instead of an appended
 *  evidence entry. */
export function updateMemoryStatement(
  db: Database.Database,
  id: string,
  newStatement: string,
  newEmbedding: Float32Array
): Memory | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined
  if (!row) return null
  const existing = rowToMemory(row)
  const now = new Date().toISOString()
  const updateMemoryStmt = db.prepare(
    "UPDATE memories SET statement = ?, confidence = 1, status = 'active', last_confirmed_at = ? WHERE id = ?"
  )
  const updateVecStmt = db.prepare('UPDATE vec_memories SET embedding = ? WHERE rowid = ?')
  const runBoth = db.transaction(() => {
    updateMemoryStmt.run(newStatement, now, id)
    updateVecStmt.run(toBlob(newEmbedding), BigInt(row.rowid_pk))
  })
  runBoth()
  return { ...existing, statement: newStatement, confidence: 1, status: 'active', lastConfirmedAt: now }
}

export function setMemoryPinned(db: Database.Database, id: string, pinned: boolean): Memory | null {
  const existing = getMemoryById(db, id)
  if (!existing) return null
  db.prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  return { ...existing, pinned }
}

/** A genuine hard delete (unlike invalidateMemory/setMemoryStatus, which
 *  are soft transitions that keep history) — this is the rep explicitly
 *  saying "no, forget this specific thing," not the consolidation engine
 *  superseding or aging something out. Both tables, atomically — a
 *  vec_memories row with no matching memories row is exactly the corruption
 *  insertMemory's own atomic transaction was built to prevent, so deletion
 *  gets the same guarantee. */
export function deleteMemory(db: Database.Database, id: string): boolean {
  const rowidPk = db.prepare('SELECT rowid_pk FROM memories WHERE id = ?').get(id) as
    | { rowid_pk: number }
    | undefined
  if (!rowidPk) return false
  const deleteBoth = db.transaction(() => {
    db.prepare('DELETE FROM vec_memories WHERE rowid = ?').run(BigInt(rowidPk.rowid_pk))
    db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  })
  deleteBoth()
  return true
}

/** Spec section 4's "Forget everything" — a full wipe, both tables,
 *  everything (every scope, not just one). Deliberately blunt: this is a
 *  rare, explicit, confirmed destructive action (memory-center-ipc.ts gates
 *  it behind a confirmation dialog), not something with a partial/scoped
 *  variant to get subtly wrong. compiled_profiles is cleared too — a stale
 *  compiled profile referencing facts that no longer exist would be worse
 *  than an empty one. */
export function forgetEverything(db: Database.Database): void {
  const wipe = db.transaction(() => {
    db.exec('DELETE FROM vec_memories')
    db.exec('DELETE FROM memories')
    db.exec('DELETE FROM compiled_profiles')
  })
  wipe()
}

/** Every memory with at least one transcript-type evidence entry pointing
 *  at `callId` — the post-call review screen's data source (spec section
 *  4's "Sales Brain learned N things from this call — Review"). Filtered
 *  in JS, not SQL (evidence is a JSON blob column) — fine at this scale
 *  (a rep's own memory count, not a shared database). */
export function listMemoriesByCallId(db: Database.Database, callId: string): Memory[] {
  const all = db.prepare('SELECT * FROM memories').all() as MemoryRow[]
  return all
    .map(rowToMemory)
    .filter((m) => m.evidence.some((e) => e.type === 'transcript' && e.callId === callId))
}

/**
 * AUDIT FIX (2026-08-24) — forget what ONE call/conversation taught, instead
 * of deleting every memory it ever touched.
 *
 * The bug this replaces: consolidateNewCandidate reinforces an EXISTING
 * memory by appending the new candidate's evidence entry, which carries THIS
 * conversation's callId (`assistant:<conversationId>` for chat), onto a row
 * that may have been learned months earlier from an unrelated call — the
 * exact-match lookup is scope-wide, and 'rep'/'business' are global singleton
 * scopes shared by every call and every Rise chat. listMemoriesByCallId then
 * matches on ANY evidence entry, and all four exclusion sites called
 * deleteMemory on the whole row.
 *
 * So: a January call teaches "Acme's budget cycle ends in March". In February
 * the rep restates it in a Rise chat, which reinforces that same row. The rep
 * flips "Not learning" on the CHAT — and January's memory is hard-deleted,
 * both tables, no soft state, no changelog row surviving. They were told only
 * that this chat would be forgotten.
 *
 * The fix is evidence-level, matching what the UI actually promises:
 * "anything it already taught the Sales Brain will be forgotten" — IT, this
 * source, not everything that agrees with it. A memory loses this call's
 * evidence; it is deleted only when that was its LAST evidence, i.e. when
 * this source really was the only thing holding it up.
 *
 * distinctEpisodeCount is derived from evidence (consolidation.ts:250), so
 * promotion and decay maths self-correct once the entry is gone — nothing to
 * decrement by hand.
 *
 * lastConfirmedAt is deliberately left alone: MemoryEvidence carries no
 * timestamp, so there is no honest earlier value to roll back to. The only
 * effect is that decay restarts from a slightly later date than it strictly
 * should — conservative in the harmless direction, and a fabricated timestamp
 * would be worse than a slightly generous one.
 */
export interface ForgetCallResult {
  /** Memories removed entirely — this call was their only evidence. */
  deleted: number
  /** Memories that survived with this call's evidence pruned. */
  pruned: number
}

export function forgetCallContribution(
  db: Database.Database,
  callId: string
): ForgetCallResult {
  const affected = listMemoriesByCallId(db, callId)
  let deleted = 0
  let pruned = 0
  for (const memory of affected) {
    const remaining = memory.evidence.filter(
      (e) => !(e.type === 'transcript' && e.callId === callId)
    )
    if (remaining.length === 0) {
      if (deleteMemory(db, memory.id)) deleted++
    } else {
      db.prepare('UPDATE memories SET evidence = ? WHERE id = ?').run(
        JSON.stringify(remaining),
        memory.id
      )
      pruned++
    }
  }
  return { deleted, pruned }
}

export interface ChangelogEntry {
  memoryId: string
  statement: string
  scope: MemoryScope
  kind: 'created' | 'reinforced' | 'invalidated'
  at: string
}

/** Spec section 4's changelog ("what was learned/updated/invalidated and
 *  when") — DERIVED from each memory's own timestamps rather than a
 *  separate audit-log table: createdAt is always a 'created' entry;
 *  lastConfirmedAt strictly after createdAt means it's been reinforced at
 *  least once since (a 'reinforced' entry, timestamped at the LATEST
 *  reinforcement — the exact history of every individual reinforcement
 *  isn't separately tracked, matching this app's general "simple
 *  architecture first" precedent rather than adding a new table for a
 *  trust-UI nicety); invalidatedAt, when present, is an 'invalidated'
 *  entry. Sorted newest first. */
export function buildChangelog(db: Database.Database, scope?: MemoryScope, limit = 50): ChangelogEntry[] {
  const memories = listMemories(db, scope ? { scope } : {})
  const entries: ChangelogEntry[] = []
  for (const m of memories) {
    entries.push({ memoryId: m.id, statement: m.statement, scope: m.scope, kind: 'created', at: m.createdAt })
    if (m.lastConfirmedAt !== m.createdAt) {
      entries.push({
        memoryId: m.id,
        statement: m.statement,
        scope: m.scope,
        kind: 'reinforced',
        at: m.lastConfirmedAt
      })
    }
    if (m.invalidatedAt) {
      entries.push({ memoryId: m.id, statement: m.statement, scope: m.scope, kind: 'invalidated', at: m.invalidatedAt })
    }
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)
}
