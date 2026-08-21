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
import { isSalesBrainEnabled } from '../app-settings'
import { getMemoryDb } from './memory-runtime'
import { embedText } from './embeddings'
import { searchMemoriesByVector } from './memories-store'
import { clientScope, type MemoryScope } from './types'

const MAX_RESULTS = 5

/** BUG-080 — vec_memories is a plain `vec0` table, so distances are
 *  EUCLIDEAN (L2), not cosine: on MiniLM's unit vectors a natural-language
 *  paraphrase of a stored fact lands around L2 1.0–1.25 (cos-sim ~0.2–0.5).
 *  The original 0.6 here was written in cosine terms and, in L2 reality,
 *  demanded ~82% cosine similarity — so retrieval returned NOTHING for
 *  essentially every real question, silently, since M25. 1.3 is the
 *  operating point chosen by M28's retrieval-quality harness from a 7-value
 *  sweep (recall 0/14 → 13/14, MRR 0.79, zero empty answers, zero
 *  cross-client scope violations; 1.4 added nothing — see the M28 branch's
 *  docs/M28-retrieval-baseline.md). Consolidation's 0.35 dedupe threshold is
 *  the same L2 scale but deliberately unchanged — "probably the same fact"
 *  SHOULD demand near-identity. */
const MAX_DISTANCE = 1.3

/** Returns a labeled context section (same shape as profile-injection.ts's
 *  *Section() helpers) built from whichever ACTIVE memories are most
 *  relevant to `query` across rep + business + (if linked) this client's
 *  scope — or '' when Sales Brain is off, nothing's compiled yet, or
 *  nothing crosses the relevance bar. Every included memory keeps its
 *  confidence visible so the coach can phrase it appropriately (spec
 *  section 5: hypotheses are voiced as observations, never fact — though
 *  by construction this only ever returns 'active' memories, the higher-
 *  confidence tier, since searchMemoriesByVector defaults to that). */
export async function retrieveRelevantMemories(query: string, contactId: string | null): Promise<string> {
  if (!isSalesBrainEnabled() || !query.trim()) return ''
  const db = getMemoryDb()
  if (!db) return ''

  const embedding = await embedText(query)
  const scopes: MemoryScope[] = ['rep', 'business', ...(contactId ? [clientScope(contactId)] : [])]
  const results = scopes
    .flatMap((scope) => searchMemoriesByVector(db, embedding, { scope, limit: MAX_RESULTS }))
    .filter((r) => r.distance <= MAX_DISTANCE)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_RESULTS)

  if (!results.length) return ''
  const lines = results.map((r) => `- ${r.memory.statement} (confidence: ${Math.round(r.memory.confidence * 100)}%)`)
  return `\n\n--- MEMORIES RELEVANT TO THIS QUESTION (Sales Brain) ---\n${lines.join('\n')}`
}
