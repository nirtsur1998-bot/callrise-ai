// M25 Sales Brain — shared types for the memory module. No Electron import,
// no better-sqlite3 import — kept pure so extraction/verification logic
// (the security-critical part) stays unit-testable without a real DB, same
// convention as contact-intelligence.ts/objection-mining.ts.

/** 'rep' and 'business' are singletons; 'client:<contactId>' is one per
 *  contact — the same three-tier split the milestone spec asks for. Kept as
 *  a plain string union + a `clientScope()`/`parseScope()` pair (below)
 *  rather than a discriminated union, since it needs to round-trip through
 *  SQLite TEXT columns and JSON evidence payloads without a serialization
 *  step. */
export type MemoryScope = 'rep' | 'business' | `client:${string}`

export function clientScope(contactId: string): MemoryScope {
  return `client:${contactId}`
}

export function parseScope(scope: string): { kind: 'rep' | 'business' | 'client'; contactId?: string } {
  if (scope === 'rep') return { kind: 'rep' }
  if (scope === 'business') return { kind: 'business' }
  if (scope.startsWith('client:')) return { kind: 'client', contactId: scope.slice('client:'.length) }
  return { kind: 'rep' } // unrecognized — never throw on a malformed scope, treat as the safest default
}

/** The extraction ALLOWLIST (spec section 5's hard guardrail: "Auto-
 *  extraction is allowlist-only"). Nothing outside this list is ever
 *  auto-stored — the extraction prompt/tool schema is built directly from
 *  this list (see extraction.ts), so a category can't silently drift out of
 *  sync between "what the prompt asks for" and "what's actually allowed." */
export const MEMORY_CATEGORIES = [
  // rep
  'selling-pattern',
  'skill-strength',
  'skill-weakness',
  'stated-goal',
  'stated-struggle',
  'communication-style',
  'preference',
  // business
  'product-or-service',
  'pricing-model',
  'icp',
  'objection-and-response',
  'competitor',
  'terminology',
  // client — BUG-196 shape (c), the founder's decision 2026-09-06 night:
  // the five topics the extraction harness has scored since M27, as real
  // names, plus 'client-fact' as the RESIDUAL. A client fact that fits none
  // of the five is 'client-fact' and is never refused for not fitting; the
  // residual's share of a store is the measurable signal that this list is
  // wrong for that user (shown in the Memory Center).
  'client-budget', // money: budget, expected spend, price sensitivity
  'client-timeline', // any dated intent: go-live, deadline, follow-up date, "before peak season"
  'client-decision', // who decides, approval thresholds, the process
  'client-need', // the pain and the goal it implies: current tools, process, constraints, what they want fixed
  'client-concern', // what they are worried about, hesitant on, objecting to
  'client-fact' // the residual: everything else about the client
] as const

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/** The residual client category — where shape (b)'s remap lands a
 *  client-claimed rep/business category, and where a client fact that fits
 *  none of the named client categories belongs. Never a refusal reason. */
export const CLIENT_RESIDUAL_CATEGORY: MemoryCategory = 'client-fact'

/** Every category bound to the client scope kind — derived from
 *  CATEGORY_SCOPE_KIND below, never listed twice. Consolidation checks
 *  contradictions across this whole family (the founder's call: a budget
 *  filed as a need must still supersede a budget filed as a budget). */
export function isClientCategory(category: MemoryCategory): boolean {
  return CATEGORY_SCOPE_KIND[category] === 'client'
}

/** Which rep/business categories are legal for which scope — enforced in
 *  extraction.ts so a candidate memory can never be saved under a scope its
 *  own category doesn't belong to (e.g. a 'client-fact' can never land in
 *  the 'rep' or 'business' scope, and vice versa). */
export const CATEGORY_SCOPE_KIND: Record<MemoryCategory, 'rep' | 'business' | 'client'> = {
  'selling-pattern': 'rep',
  'skill-strength': 'rep',
  'skill-weakness': 'rep',
  'stated-goal': 'rep',
  'stated-struggle': 'rep',
  'communication-style': 'rep',
  preference: 'rep',
  'product-or-service': 'business',
  'pricing-model': 'business',
  icp: 'business',
  'objection-and-response': 'business',
  competitor: 'business',
  terminology: 'business',
  'client-budget': 'client',
  'client-timeline': 'client',
  'client-decision': 'client',
  'client-need': 'client',
  'client-concern': 'client',
  'client-fact': 'client'
}

/** 'archived' is Phase 2's addition — the decay engine's end state for a
 *  hypothesis that was never reconfirmed and its confidence dropped far
 *  enough (spec section 2's DECAY step: "below threshold → status drops to
 *  hypothesis... much lower → archived"). An archived memory is never
 *  asserted or surfaced (same as invalidated), but is semantically distinct
 *  from invalidated: invalidated means "a later fact contradicted and
 *  replaced this one" (the fact was wrong or changed), archived means "this
 *  just faded from disuse" (the fact may still be true, nobody's confirmed
 *  it in a long time). Kept as a plain TEXT value, no migration needed to
 *  add it — SQLite doesn't enforce an enum on this column, only this
 *  module's own code does. */
export type MemoryStatus = 'active' | 'hypothesis' | 'invalidated' | 'archived'

export type MemorySource = 'auto' | 'user_stated' | 'user_confirmed'

/** One piece of grounding for a memory. Two kinds:
 *  - 'transcript': a reference back to the real transcript/chat text the
 *    statement was extracted from — `quote` is verbatim, verified against
 *    the source the same way contact-intelligence.ts's verifyDetectedName()
 *    verifies a claimed self-intro quote (see extraction.ts's
 *    verifyEvidenceQuote()). This is what every Phase 1 extraction produces.
 *  - 'reflection': Phase 2's addition — the reflection pass (consolidation.
 *    ts) synthesizes a higher-order insight FROM other memories, not from a
 *    transcript directly. Its "evidence" is which memories support it, not
 *    a quote — spec section 2's guardrail requires at least 2 independent
 *    supporting memories before a reflection is allowed to exist at all
 *    (see consolidation.ts's runReflection()).
 *  Every assertion the coach ever makes must be traceable to something the
 *  user can view (spec section 5) — a 'reflection' memory's evidence trail
 *  is traceable transitively, through the memories it cites. */
export type MemoryEvidence =
  | {
      type: 'transcript'
      callId: string
      chatMessageId?: string
      quote: string
      /** M36 Stage 3 item 5 — EVENT time: when the call (or chat message) this
       *  evidence came from happened, ISO. Distinct from the memory's
       *  createdAt, which is when we LEARNED it — an import can learn a March
       *  fact in September. Optional: evidence recorded before this field
       *  existed has none, and the temporal backfill resolves the call's date
       *  from the calls store instead. */
      at?: string
    }
  | { type: 'reflection'; memoryIds: string[] }

/** M36 Stage 3 item 5 — where a validity date came from. The founder's
 *  condition for the backfill: "a dated fact whose date is wrong is worse
 *  than an undated one", so an approximate date is never silently a date.
 *    'call'   — the evidence call's own start time (real event time)
 *    'stated' — the user said it themselves, at that moment (exact by definition)
 *    'approx' — the LEARNING time (createdAt / invalidatedAt) used because
 *               no event time could be recovered; shown as approximate. */
export type ValidityDateSource = 'call' | 'stated' | 'approx'

export interface Memory {
  id: string
  scope: MemoryScope
  category: MemoryCategory
  statement: string
  evidence: MemoryEvidence[]
  confidence: number
  importance: number
  status: MemoryStatus
  source: MemorySource
  pinned: boolean
  invalidatedBy?: string
  createdAt: string
  lastConfirmedAt: string
  /** M36 — when retrieval last surfaced this memory to a feature; null until
   *  it has been. Decay runs from the later of this and lastConfirmedAt. */
  lastRetrievedAt?: string | null
  invalidatedAt?: string
  /** M36 Stage 3 item 5 — EVENT time (when the fact was true), beside the
   *  SYSTEM time above (when we learned / invalidated it). Both kept, neither
   *  overwritten — the bi-temporal split. NULL validFrom on a row that
   *  predates migration 6 and has not been backfilled yet means "true since
   *  at least when we learned it". validUntil NULL means still true as far as
   *  we know. Each date carries its source (see ValidityDateSource). */
  validFrom?: string | null
  validFromSource?: ValidityDateSource | null
  validUntil?: string | null
  validUntilSource?: ValidityDateSource | null
}

/** What extraction.ts produces BEFORE it's ever written to the DB — no id,
 *  no status/timestamps yet, since those are assigned at write time
 *  (memories-store.ts). Kept as a separate type (not `Partial<Memory>`) so
 *  a caller can't accidentally construct a candidate that's missing a
 *  REQUIRED field via an overly-permissive Partial. */
export interface MemoryCandidate {
  scope: MemoryScope
  category: MemoryCategory
  statement: string
  evidence: MemoryEvidence[]
  confidence: number
  importance: number
  source: MemorySource
}

/** L4 WORKING MEMORY (spec section 1) — the compiled, token-budgeted
 *  profile document injected into other features' prompts. THREE sizes per
 *  scope, precompiled by consolidation.ts's compileProfile() at the end of
 *  every consolidation run — never assembled at request time, so injecting
 *  it anywhere (live cues, coaching, chat) adds zero latency. 'micro' is
 *  the only size ever injected on the live-cue path (spec: ~150 tokens);
 *  'standard' (~500) for coaching/briefs/CRM; 'full' (~1200) for coaching
 *  chat, which can afford the largest context. */
export type ProfileSize = 'micro' | 'standard' | 'full'

export interface CompiledProfile {
  scope: MemoryScope
  size: ProfileSize
  text: string
  generatedAt: string
}
