// M25 Sales Brain Phase 2 — the consolidation engine (spec section 2's
// CONSOLIDATE step): dedupe/merge, contradiction handling, episodic→
// semantic promotion, nightly reflection, decay, and the L4 profile
// compiler. "Smart model for judgment, deterministic code for structure"
// (spec) — every AI call here is a real judgment call (is this the same
// fact? does it contradict? is this pattern real?), while promotion,
// decay math, and profile compilation are plain, deterministic,
// independently-unit-testable code with no AI involved at all.
//
// No Electron import — pure/testable core, same convention as every other
// module in this directory. memory-hooks.ts calls consolidateNewCandidate()
// in place of Phase 1's naive exact-match-only dedupe; memory-runtime.ts
// (or index.ts) triggers runNightlyConsolidation() on a once-per-~20h timer.
import type Database from 'better-sqlite3'
import type { AITool } from '../ai/types'
import { completeWithFallback } from '../ai/complete-with-fallback'
import { embedText } from './embeddings'
import {
  insertMemory,
  invalidateMemory,
  listDistinctScopes,
  listMemories,
  promoteToActive,
  reinforceMemory,
  searchMemoriesByVector,
  setMemoryStatus,
  updateConfidence,
  upsertCompiledProfile
} from './memories-store'
import type { CompiledProfile, Memory, MemoryCandidate, MemoryEvidence, MemoryScope, ProfileSize } from './types'

function normalizeStatement(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

// --- Dedupe / merge ----------------------------------------------------

const DUPLICATE_VECTOR_DISTANCE_THRESHOLD = 0.35 // cosine-ish distance from a normalized embedding; empirically "clearly related" territory, not just "same broad topic"

const MERGE_JUDGE_TOOL: AITool = {
  name: 'judge_same_fact',
  description: 'Decide whether two statements describe the exact same underlying fact.',
  inputSchema: {
    type: 'object',
    properties: {
      sameFact: {
        type: 'boolean',
        description:
          'True only if both statements are clearly describing the SAME underlying fact (possibly worded differently). False if they are related but distinct facts, or if either is meaningfully more specific/different than the other.'
      }
    },
    required: ['sameFact'],
    additionalProperties: false
  }
}

/** Smart-model judgment call: are two DIFFERENTLY-WORDED statements the
 *  same underlying fact? Only ever called on a candidate that already
 *  passed a cheap vector-similarity pre-filter (findNearestExisting) — this
 *  keeps AI calls rare (most candidates are either exact-duplicate, cheaply
 *  caught before this, or genuinely unrelated to anything existing, also
 *  cheaply excluded by the vector search itself never returning them).
 *  Best-effort: on any AI failure, treats it as "not the same fact" — the
 *  safer default, since a false-negative here just means two similar
 *  memories coexist a bit longer (Phase 2's own scope, or a LATER
 *  consolidation pass, would catch it), while a false-positive would
 *  silently merge two genuinely different facts into one. */
async function judgeSameFact(a: string, b: string): Promise<boolean> {
  try {
    const result = await completeWithFallback({
      purpose: 'memory-consolidate',
      maxTokens: 200,
      tool: MERGE_JUDGE_TOOL,
      messages: [
        {
          role: 'user',
          content: `Statement A: "${a}"\nStatement B: "${b}"\n\nAre these the same underlying fact?`
        }
      ]
    })
    return result.toolInput?.sameFact === true
  } catch {
    return false
  }
}

const CONTRADICTION_JUDGE_TOOL: AITool = {
  name: 'judge_contradiction',
  description: 'Decide whether a new statement contradicts any of a list of existing statements about the same subject.',
  inputSchema: {
    type: 'object',
    properties: {
      contradictsIndex: {
        type: ['integer', 'null'],
        description:
          'The 0-based index (into the provided EXISTING list) of the one statement the NEW statement genuinely contradicts (states the opposite, or is incompatible with — not just different/unrelated). Null if the new statement does not contradict any of them.'
      }
    },
    required: ['contradictsIndex'],
    additionalProperties: false
  }
}

/**
 * M27 C1 — how many independent episodes a HYPOTHESIS needs before it is
 * worth contradiction-checking against.
 *
 * The tradeoff this number resolves: checking every hypothesis would charge
 * an AI call for every fresh single-mention candidate against every other
 * one — and on a new install, where nothing is active yet, that means paying
 * on essentially every extraction (the `length === 0` early return below used
 * to skip the call entirely in exactly that case). Checking none was the old
 * behaviour, and it's what let two contradictory memories coexist forever.
 *
 * 2 is the founder's call, and it is aimed at a specific real failure: the
 * memory that caused visible harm was a RESTATED fact ("don't chase this yet"
 * heard across more than one call), not a one-off. Requiring a second
 * independent episode keeps the check pointed at facts the system has already
 * seen twice — the ones actually shaping a client's profile — while a single
 * unconfirmed mention stays cheap and silent until it earns a second.
 */
const CONTRADICTION_MIN_EPISODES_FOR_HYPOTHESIS = 2

/** Contradiction detection (spec section 2, Zep-style temporal
 *  invalidation), in the same scope+category — cross-category contradiction
 *  ("prefers Slack" vs "charges per-seat") is nonsensical by construction.
 *  Best-effort: on failure, no contradiction is assumed (same safer-default
 *  reasoning as judgeSameFact).
 *
 *  M27 C1 — this used to check ACTIVE memories ONLY, on the reasoning that
 *  "a hypothesis contradicting another hypothesis isn't worth an AI call yet
 *  (neither is trusted enough to matter)". That was wrong in a way that
 *  produced real, visible harm: EVERY auto-extracted memory starts as a
 *  hypothesis (memories-store.ts's initialStatus), so two flatly
 *  contradictory statements — "don't chase this yet" and, weeks later,
 *  "they're ready to move" — were never compared to each other at all. The
 *  similarity check above correctly declines to merge them (they are
 *  opposites, not restatements), so both were simply stored, both fed the
 *  compiled profile and retrieval, and the AI could be told both things about
 *  the same client. Worse, each could independently reach the promotion
 *  threshold, since promoteHypotheses() does no contradiction check either —
 *  turning two contradictory hunches into two contradictory "facts".
 *
 *  The real-world case this exists for is not an extraction error but a
 *  genuine CHANGE OVER TIME: both statements were true when said. That is
 *  precisely what temporal invalidation is for, and the handling is
 *  unchanged from the active case — supersede the older, never delete it,
 *  and link it forward to whatever replaced it (see invalidateMemory), so
 *  it stays visible and auditable in Memory Center. */
async function detectContradiction(
  db: Database.Database,
  candidate: MemoryCandidate
): Promise<Memory | null> {
  const comparable = listMemories(db, {
    scope: candidate.scope,
    statuses: ['active', 'hypothesis'],
    category: candidate.category
  }).filter(
    (m) =>
      m.status === 'active' ||
      distinctEpisodeCount(m.evidence) >= CONTRADICTION_MIN_EPISODES_FOR_HYPOTHESIS
  )
  if (comparable.length === 0) return null

  try {
    const result = await completeWithFallback({
      purpose: 'memory-consolidate',
      maxTokens: 200,
      tool: CONTRADICTION_JUDGE_TOOL,
      messages: [
        {
          role: 'user',
          content: `NEW statement: "${candidate.statement}"\n\nEXISTING statements:\n${comparable
            .map((m, i) => `${i}. ${m.statement}`)
            .join('\n')}\n\nDoes the NEW statement contradict any of the EXISTING ones?`
        }
      ]
    })
    const idx = result.toolInput?.contradictsIndex
    if (typeof idx !== 'number' || idx < 0 || idx >= comparable.length) return null
    return comparable[idx]
  } catch {
    return null
  }
}

/** The Phase 2 replacement for Phase 1's naive exact-statement-match
 *  dedupe in memory-hooks.ts. Order of checks, cheapest/safest first:
 *  1. Exact restatement (case/whitespace-insensitive) → reinforce, no AI call.
 *  2. Vector-similar candidates → ask the smart model if it's really the
 *     same fact; if so, reinforce that one instead of inserting a duplicate.
 *  3. Contradiction check against active memories in the same scope+category
 *     → if found, the OLD memory is temporally invalidated (never deleted)
 *     and the NEW candidate is inserted fresh, linked forward via
 *     invalidatedBy.
 *  4. Genuinely new → insert as a fresh (hypothesis, unless user-sourced)
 *     memory.
 *
 *  Returns which outcome happened — memory-hooks.ts uses this to count
 *  genuinely NEW memories per call (not reinforcements) for the post-call
 *  review notification (spec section 4: "Sales Brain learned N things from
 *  this call"), so "N" means something real, not just "N candidates were
 *  considered." */
export async function consolidateNewCandidate(
  db: Database.Database,
  candidate: MemoryCandidate
): Promise<'reinforced' | 'created'> {
  const existingInScope = listMemories(db, { scope: candidate.scope, statuses: ['active', 'hypothesis'] })
  const exactMatch = existingInScope.find(
    (m) => normalizeStatement(m.statement) === normalizeStatement(candidate.statement)
  )
  if (exactMatch) {
    reinforceMemory(db, exactMatch.id, candidate.evidence[0])
    return 'reinforced'
  }

  const embedding = await embedText(candidate.statement)
  const nearby = searchMemoriesByVector(db, embedding, {
    scope: candidate.scope,
    statuses: ['active', 'hypothesis'],
    limit: 3
  }).filter((r) => r.distance <= DUPLICATE_VECTOR_DISTANCE_THRESHOLD)

  for (const { memory } of nearby) {
    if (await judgeSameFact(candidate.statement, memory.statement)) {
      reinforceMemory(db, memory.id, candidate.evidence[0])
      return 'reinforced'
    }
  }

  const contradicted = await detectContradiction(db, candidate)
  const inserted = insertMemory(db, candidate, embedding)
  if (contradicted) {
    invalidateMemory(db, contradicted.id, inserted.id)
  }
  return 'created'
}

// --- Episodic → semantic promotion --------------------------------------

/** A "distinct episode" is one independent confirming occasion — a
 *  transcript-evidence entry counts by its callId (two evidence entries
 *  from the SAME call are one episode, not two); a reflection-evidence
 *  entry counts by its own memoryIds set (a reflection reconfirmed on a
 *  LATER consolidation run, citing the same or an overlapping set of
 *  memories, is a genuinely independent episode the same way a second call
 *  is). Exported directly for unit testing — this is the exact mechanism
 *  spec section 2's "one call is a hypothesis, never a fact" guardrail
 *  depends on, so it needs to be verifiably correct on its own. */
export function distinctEpisodeCount(evidence: MemoryEvidence[]): number {
  const keys = new Set(
    evidence.map((e) => (e.type === 'transcript' ? `call:${e.callId}` : `reflection:${[...e.memoryIds].sort().join(',')}`))
  )
  return keys.size
}

const PROMOTION_THRESHOLD_EPISODES = 3

/** Promotes every hypothesis in `scope` with enough independent evidence
 *  episodes to 'active' (spec section 2's episodic→semantic promotion —
 *  "a pattern seen in 3+ calls becomes a durable fact... one call is a
 *  hypothesis, never a fact"). Pure DB work, no AI call — cheap enough to
 *  run after every single call, not just nightly. */
export function promoteHypotheses(db: Database.Database, scope: MemoryScope): void {
  const hypotheses = listMemories(db, { scope, status: 'hypothesis' })
  for (const memory of hypotheses) {
    if (distinctEpisodeCount(memory.evidence) >= PROMOTION_THRESHOLD_EPISODES) {
      promoteToActive(db, memory.id)
    }
  }
}

// --- Reflection ----------------------------------------------------------

const REFLECT_TOOL: AITool = {
  name: 'record_reflections',
  description: 'Record higher-order patterns noticed across a set of existing memories.',
  inputSchema: {
    type: 'object',
    properties: {
      reflections: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            statement: {
              type: 'string',
              description: 'One clear sentence stating the higher-order pattern noticed.'
            },
            supportingIndexes: {
              type: 'array',
              minItems: 2,
              items: { type: 'integer' },
              description:
                'At least 2 indexes (0-based) into the provided memory list that independently support this pattern. A pattern with fewer than 2 genuinely independent supporting memories must not be reported at all.'
            },
            confidence: { type: 'number', description: '0 to 1 — how confident, based purely on the supporting memories given.' }
          },
          required: ['statement', 'supportingIndexes', 'confidence'],
          additionalProperties: false
        }
      }
    },
    required: ['reflections'],
    additionalProperties: false
  }
}

const REFLECT_PROMPT = `
Below is a list of established facts about a sales rep (or their business, or a client). Look for a higher-order PATTERN across multiple of them — something only visible by connecting at least two of these facts together, not something already stated by any single one alone.

Only report a pattern if you can point to at least 2 of the facts below that genuinely, independently support it. If you can't find any such pattern, return an empty reflections array — that's the normal, expected result most of the time.

Never restate a single fact as if it were a new pattern. Never invent supporting facts that aren't in the list below.
`.trim()

const REFLECTION_CONFIDENCE_CAP = 0.5

/** Nightly reflection pass (spec section 2). Reads only ACTIVE memories
 *  (well-established facts, not other hypotheses or reflections still
 *  waiting to be trusted — reflecting on unreliable input would compound
 *  unreliability). Every produced reflection MECHANICALLY must cite >=2
 *  real indexes from the list actually given to the model — a claimed
 *  reflection citing 0 or 1 supporting memories, or an out-of-range index,
 *  is dropped before ever being saved, not just discouraged by the prompt
 *  (spec section 2's explicit guardrail: "require >=2 independent evidence
 *  episodes"). Every reflection that survives is created as a hypothesis
 *  with capped confidence (spec: "capped confidence") — it NEVER starts
 *  active, regardless of what the model claims. */
export async function runReflection(db: Database.Database, scope: MemoryScope): Promise<void> {
  const activeMemories = listMemories(db, { scope, status: 'active' })
  if (activeMemories.length < 2) return // can't possibly have 2 independent supporters

  let raw: unknown
  try {
    const result = await completeWithFallback({
      purpose: 'memory-reflect',
      maxTokens: 1000,
      tool: REFLECT_TOOL,
      messages: [
        {
          role: 'user',
          content: `${REFLECT_PROMPT}\n\n--- FACTS ---\n${activeMemories.map((m, i) => `${i}. ${m.statement}`).join('\n')}`
        }
      ]
    })
    raw = result.toolInput?.reflections
  } catch {
    return
  }
  if (!Array.isArray(raw)) return

  for (const item of raw as Record<string, unknown>[]) {
    const statement = typeof item.statement === 'string' ? item.statement.trim().slice(0, 500) : ''
    const supportingIndexes = Array.isArray(item.supportingIndexes)
      ? item.supportingIndexes.filter((i): i is number => typeof i === 'number')
      : []
    const validIndexes = [...new Set(supportingIndexes)].filter((i) => i >= 0 && i < activeMemories.length)
    if (!statement || validIndexes.length < 2) continue // the hard guardrail — never skippable via a confident-sounding prompt response

    const confidence = typeof item.confidence === 'number' ? Math.min(REFLECTION_CONFIDENCE_CAP, Math.max(0, item.confidence)) : REFLECTION_CONFIDENCE_CAP

    const evidence: MemoryEvidence[] = [{ type: 'reflection', memoryIds: validIndexes.map((i) => activeMemories[i].id) }]
    const embedding = await embedText(statement)
    insertMemory(
      db,
      {
        scope,
        category: activeMemories[validIndexes[0]].category,
        statement,
        evidence,
        confidence,
        importance: 5,
        source: 'auto'
      },
      embedding
    )
  }
}

// --- Decay -----------------------------------------------------------------

const DECAY_GRACE_DAYS = 14 // no decay at all within 2 weeks of last confirmation
const DECAY_HALF_LIFE_DAYS = 60 // baseline: confidence roughly halves every ~60 days of silence past the grace period
const ACTIVE_DEMOTE_THRESHOLD = 0.4
const ARCHIVE_THRESHOLD = 0.15

/** Pure decay math — exported directly for unit testing. Independently-
 *  confirmed facts (more evidence episodes) decay slower — spec section 2:
 *  "Contradicted-then-reconfirmed facts decay slower (they've survived
 *  challenge)" — interpreted here as "more independent confirmations
 *  survived the test of time better," since this schema doesn't model an
 *  explicit contradiction-then-reinstatement history to check for
 *  literally. Never returns a value outside [0, 1]. */
export function decayedConfidence(
  currentConfidence: number,
  lastConfirmedAtIso: string,
  nowIso: string,
  evidenceEpisodes: number
): number {
  const daysSince = (Date.parse(nowIso) - Date.parse(lastConfirmedAtIso)) / (1000 * 60 * 60 * 24)
  const daysPastGrace = Math.max(0, daysSince - DECAY_GRACE_DAYS)
  if (daysPastGrace === 0) return currentConfidence

  const resistance = Math.max(1, evidenceEpisodes) // more episodes = slower decay
  const effectiveHalfLife = DECAY_HALF_LIFE_DAYS * resistance
  const decayFactor = Math.pow(0.5, daysPastGrace / effectiveHalfLife)
  return Math.max(0, Math.min(1, currentConfidence * decayFactor))
}

/** Applies decay across every non-exempt memory in `scope`. Salience floor
 *  (spec section 2): pinned memories and directly user-sourced ones
 *  (user_stated/user_confirmed — the user IS the evidence, there's nothing
 *  to "reconfirm" via more calls) never decay to invisibility, skipped
 *  entirely. */
export function decayMemories(db: Database.Database, scope: MemoryScope): void {
  const now = new Date().toISOString()
  const candidates = listMemories(db, { scope, statuses: ['active', 'hypothesis'] })
  for (const memory of candidates) {
    if (memory.pinned || memory.source === 'user_stated' || memory.source === 'user_confirmed') continue

    const next = decayedConfidence(memory.confidence, memory.lastConfirmedAt, now, distinctEpisodeCount(memory.evidence))
    if (next === memory.confidence) continue
    updateConfidence(db, memory.id, next)

    if (next < ARCHIVE_THRESHOLD) {
      setMemoryStatus(db, memory.id, 'archived')
    } else if (next < ACTIVE_DEMOTE_THRESHOLD && memory.status === 'active') {
      setMemoryStatus(db, memory.id, 'hypothesis')
    }
  }
}

// --- Profile compilation (L4) ---------------------------------------------

const PROFILE_CHAR_BUDGET: Record<ProfileSize, number> = {
  // Rough 1-token ≈ 4-chars rule of thumb — deterministic template, no AI
  // call, so it's fine that this is an estimate, not an exact tokenizer
  // count: the point is staying comfortably within the spec's ~150/500/1200
  // token budgets, not hitting them precisely.
  micro: 500,
  standard: 1800,
  full: 4200
}

/** Deterministic — spec section 2: "smart model for judgment, deterministic
 *  code for structure." Builds a compact profile from ACTIVE memories only
 *  (never hypotheses or invalidated/archived ones — spec section 5:
 *  invalidated memories are never asserted, and an unconfirmed hypothesis
 *  has no business being injected into another feature's prompt as if it
 *  were known fact), ranked by importance × confidence, truncated to the
 *  size's character budget without ever cutting a statement mid-sentence. */
export function buildProfileText(memories: Memory[], size: ProfileSize): string {
  const ranked = [...memories].sort((a, b) => b.importance * b.confidence - a.importance * a.confidence)
  const budget = PROFILE_CHAR_BUDGET[size]
  const lines: string[] = []
  let used = 0
  for (const m of ranked) {
    const line = `- ${m.statement}`
    if (used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  return lines.join('\n')
}

export async function compileProfile(db: Database.Database, scope: MemoryScope, size: ProfileSize): Promise<void> {
  const active = listMemories(db, { scope, status: 'active' })
  const profile: CompiledProfile = {
    scope,
    size,
    text: buildProfileText(active, size),
    generatedAt: new Date().toISOString()
  }
  upsertCompiledProfile(db, profile)
}

async function compileAllSizes(db: Database.Database, scope: MemoryScope): Promise<void> {
  for (const size of ['micro', 'standard', 'full'] as ProfileSize[]) {
    await compileProfile(db, scope, size)
  }
}

// --- Orchestration ---------------------------------------------------------

/** The "post-call" light pass (spec section 2: "runs post-call + a deeper
 *  nightly/idle pass"). Cheap: promotion is pure DB work, profile
 *  recompilation is deterministic — no reflection or decay here, those are
 *  the nightly pass's job. Called after memory-hooks.ts has already saved
 *  whatever new candidates this call/message produced. */
export async function runLightConsolidation(db: Database.Database, scope: MemoryScope): Promise<void> {
  promoteHypotheses(db, scope)
  await compileAllSizes(db, scope)
}

/** The deeper nightly/idle pass — reflection + decay across every scope
 *  that has data, then a full profile recompile for each (spec: "Recompile
 *  the L4 profiles at the end of every consolidation run"). Triggered from
 *  memory-runtime.ts on a once-per-~20h timer (this app has no true cron
 *  infrastructure — see docs/M25-sales-brain.md for why that's the right
 *  call here rather than building one). */
export async function runNightlyConsolidation(db: Database.Database): Promise<void> {
  const scopes = listDistinctScopes(db)
  for (const scope of scopes) {
    decayMemories(db, scope)
    await runReflection(db, scope)
    promoteHypotheses(db, scope) // a reflection reconfirmed enough times can itself be promoted
    await compileAllSizes(db, scope)
  }
}
