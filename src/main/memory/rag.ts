// M25 Sales Brain Phase 4 — coaching chat's RAG half (spec section 2's
// RETRIEVE step, open-ended-question path). Distinct from profile-
// injection.ts's precompiled profiles: those are the same for every
// question ("what do you generally know about this rep"), this is a fresh
// vector search keyed to THIS SPECIFIC question — "what do you know about
// how I handle pricing objections?" should surface pricing-objection
// memories specifically, not just whatever's in the generic profile.
// Cheap: one local embedding (no AI call, see embeddings.ts) + a few fast
// SQL vector searches — no network round-trip beyond what the chat turn
// itself already needs.
//
// M28 — grew a STRUCTURED sibling (retrieveRelevantMemoriesStructured):
// the Rise assistant needs memory ids/evidence back for tappable citations,
// and the retrieval-quality eval harness needs ranked ids to score against
// golden sets. The original string-shaped function now formats the
// structured results — extended, not forked, so there is exactly one
// retrieval implementation to measure and improve in Phase 2.
import { isSalesBrainEnabled } from '../app-settings'
import { ensureMemoryDb, getMemoryDb } from './memory-runtime'
import { embedText } from './embeddings'
import { searchMemoriesByVector, type VectorSearchResult } from './memories-store'
import { clientScope, type MemoryScope, type MemoryStatus } from './types'

const MAX_RESULTS = 5
const MAX_DISTANCE = 0.6 // looser than consolidation.ts's dedupe threshold — retrieval wants "plausibly relevant", not "probably the same fact"

/** Foreground bound on the embedding step. embedText() has no timeout of its
 *  own and a cold start can block on the one-time ~23MB model download — a
 *  background hook can afford to wait, a human watching a chat turn cannot.
 *  On timeout the turn proceeds memory-blind (the caller knows: empty result
 *  with Sales Brain on) rather than hanging the whole reply. */
const FOREGROUND_EMBED_TIMEOUT_MS = 10_000

export interface RetrieveStructuredOptions {
  contactId?: string | null
  /** Also search still-hypothesis memories (they arrive flagged by their own
   *  `status`, so callers can hedge the phrasing — spec section 5). Default
   *  false: profile-parity with the original behavior. */
  includeHypotheses?: boolean
  limit?: number
  /** Foreground surfaces (a human clicked and is watching): retry a failed
   *  startup init via ensureMemoryDb() instead of silently returning [] for
   *  the whole session, and bound the embedding step. Background hooks keep
   *  the original silent-and-cheap getMemoryDb() behavior. */
  foreground?: boolean
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Ranked, structured retrieval across rep + business + (if given) one
 *  client scope. Returns [] when Sales Brain is off, the db is unavailable,
 *  the embedding step timed out (foreground), or nothing crosses the
 *  relevance bar — never throws. */
export async function retrieveRelevantMemoriesStructured(
  query: string,
  opts: RetrieveStructuredOptions = {}
): Promise<VectorSearchResult[]> {
  if (!isSalesBrainEnabled() || !query.trim()) return []

  let db = getMemoryDb()
  if (!db && opts.foreground) {
    db = (await ensureMemoryDb()).db
  }
  if (!db) return []

  const embedding = opts.foreground
    ? await withTimeout(embedText(query), FOREGROUND_EMBED_TIMEOUT_MS)
    : await embedText(query)
  if (!embedding) {
    console.warn('[rag] embedding timed out — turn proceeds without memory retrieval')
    return []
  }

  const limit = opts.limit ?? MAX_RESULTS
  const statuses: MemoryStatus[] = opts.includeHypotheses ? ['active', 'hypothesis'] : ['active']
  const contactId = opts.contactId ?? null
  const scopes: MemoryScope[] = ['rep', 'business', ...(contactId ? [clientScope(contactId)] : [])]
  return scopes
    .flatMap((scope) => searchMemoriesByVector(db, embedding, { scope, limit, statuses }))
    .filter((r) => r.distance <= MAX_DISTANCE)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
}

/** Returns a labeled context section (same shape as profile-injection.ts's
 *  *Section() helpers) built from whichever ACTIVE memories are most
 *  relevant to `query` across rep + business + (if linked) this client's
 *  scope — or '' when Sales Brain is off, nothing's compiled yet, or
 *  nothing crosses the relevance bar. Every included memory keeps its
 *  confidence visible so the coach can phrase it appropriately (spec
 *  section 5: hypotheses are voiced as observations, never fact — though
 *  by construction this only ever returns 'active' memories, the higher-
 *  confidence tier). */
export async function retrieveRelevantMemories(
  query: string,
  contactId: string | null
): Promise<string> {
  const results = await retrieveRelevantMemoriesStructured(query, { contactId })
  if (!results.length) return ''
  const lines = results.map(
    (r) => `- ${r.memory.statement} (confidence: ${Math.round(r.memory.confidence * 100)}%)`
  )
  return `\n\n--- MEMORIES RELEVANT TO THIS QUESTION (Sales Brain) ---\n${lines.join('\n')}`
}
