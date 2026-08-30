// Provider-neutral AI surface. Every text-AI call site in the app (coaching
// cues, summaries, scorecards, task generation, deal-risk, call titles,
// objection mining) routes through this instead of importing an SDK
// directly — see docs/ai-providers.md. Deepgram (transcription) is a
// separate, untouched system; this file is text-completion only.
//
// Reality check against the actual call sites (all 8 files that used the
// raw Anthropic SDK before this migration): every one of them does a single
// forced tool-call for structured JSON output, none use token streaming.
// `stream()` is still implemented on both providers for completeness/future
// use, but `complete()` with a `tool` set is the primitive that matters.

/** 'anthropic'/'openai' are the original M16 pair. The next six are M20's
 *  addition — five OpenAI-Chat-Completions-compatible providers (each built
 *  by providers/openai-compatible.ts, parameterised by base URL) plus
 *  'google' (Gemini, its own REST adapter — not OpenAI-compatible). M31 adds
 *  'zai' and 'huggingface', both OpenAI-compatible, both free-tier.
 *
 *  ONE ARRAY, TYPE DERIVED FROM IT — not a union with a hand-maintained copy
 *  elsewhere. app-settings.ts's sanitizeAIProvider() needs this list at
 *  RUNTIME to validate a persisted setting, and it carried its own literal of
 *  the same eight strings. That copy was a silent trapdoor: a provider added
 *  to the type but missed there still compiles, and the only symptom is the
 *  user's saved provider being quietly reset to 'anthropic' on load. Deriving
 *  the type from the array leaves the compiler no second version to disagree
 *  with. */
export const AI_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'groq',
  'openrouter',
  'google',
  'nvidia',
  'cerebras',
  'mistral',
  'zai',
  'huggingface',
  'cloudflare'
] as const

export type AIProviderId = (typeof AI_PROVIDER_IDS)[number]

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What the call is FOR — this drives the latency policy below and (for M16's
 *  original two providers, when no explicit `model` is set on the request)
 *  each provider's own internal model default. M20 adds 'prep-brief' for the
 *  M19 pre-meeting prep brief - no consumer exists yet (M19 Task 3B isn't
 *  built), but the model-assignment UI needs a purpose to assign a chain to
 *  ahead of that consumer landing. M24 adds 'deal-tier1' — the Live Deal
 *  Intelligence engine's fast micro-analysis pass (risk/opportunity/tactical
 *  signal detection), triggered mid-call every ~20s or off a Tier 0 event.
 *  Same latency-critical shape as 'coaching-cue' (see CHAIN_BUDGET below).
 *  M24 also adds 'deal-tier2' — the same engine's slower strategic pass
 *  (Deal Health Score, every 2-3 minutes or on a call-stage change), which
 *  can afford to think longer, same tier as 'summary'/'scorecard'.
 *  M23 Workstream B adds 'coaching-chat' — the interactive coaching-chat
 *  panel (advisor Q&A + practice/roleplay mode). Quality tier like summary/
 *  scorecard (a real conversation deserves a good model), but the FIRST
 *  real consumer of streamWithFallback() (complete-with-fallback.ts) since
 *  the user is actively watching tokens arrive. M25 adds 'memory-extract' —
 *  the Sales Brain's post-call/post-chat fact-extraction pass. Cheap/fast
 *  model tier by design (spec: "fast model for extraction, smart model for
 *  consolidation/reflection") — it's simple structured pulling against a
 *  fixed allowlist, not judgment work, and never blocks anything the user is
 *  watching (fire-and-forget, same as objection-mining/contact-intelligence).
 *  'memory-consolidate'/'memory-reflect' (Phase 2's dedupe/contradiction/
 *  reflection engine, which DOES need real judgment) are deliberately not
 *  added yet — added when that engine is actually built, same incremental
 *  pattern 'prep-brief' followed (registered ahead of its first real
 *  consumer only when the consumer was imminent, not speculatively early). */
export type AIPurpose =
  | 'coaching-cue'
  | 'summary'
  | 'scorecard'
  | 'tasks'
  | 'other'
  | 'prep-brief'
  | 'deal-tier1'
  | 'deal-tier2'
  | 'coaching-chat'
  | 'memory-extract'
  // M25 Phase 2 — the consolidation engine's judgment calls: deciding if
  // two memories are really the same fact (merge), if a new one
  // contradicts an old one (temporal invalidation), and synthesizing
  // cross-memory reflections. Quality-tier by design (spec: "smart model
  // for consolidation/reflection") — unlike extraction, these ARE judgment
  // work, not fixed-shape pulling. Both are background/nightly jobs, never
  // blocking anything the user is watching.
  | 'memory-consolidate'
  | 'memory-reflect'
  // M28 — the Rise assistant chat (the top-level AI section). Same
  // interactive-streaming shape as 'coaching-chat' but a distinct purpose on
  // purpose: its own Settings card, its own health row, its own budget knobs,
  // and a chain that can diverge from the per-call coach's without coupling.
  | 'assistant-chat'

/** A single tool the model is FORCED to call — every real call site today
 *  needs structured JSON back, never free text. `inputSchema` is a plain
 *  JSON Schema object; both providers' native tool-calling accepts this
 *  shape directly (Anthropic's `input_schema`, OpenAI's function `parameters`). */
export interface AITool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface AICompletionRequest {
  /** Top-level system prompt. Anthropic takes this as a separate `system`
   *  param; OpenAI takes it as the first message with role 'system' — each
   *  provider adapts this itself, callers never think about the difference. */
  system?: string
  messages: AIMessage[]
  maxTokens: number
  temperature?: number
  purpose: AIPurpose
  /** Explicit model ID, set by completeWithFallback() when a catalog entry
   *  is driving this call (M20). Falls back to the provider's own internal
   *  MODEL_BY_PURPOSE[purpose] default when unset — every M16-era call site
   *  that never sets this behaves exactly as it did before M20. */
  model?: string
  /** When set, the model is forced to call exactly this tool and `text` on
   *  the result is empty — the answer is in `toolInput`. */
  tool?: AITool
  /** A PDF to analyze alongside the first user message (summarize.ts's
   *  attached-file path) — each provider attaches this in its own native
   *  multimodal format (Anthropic's `document` content block, OpenAI's
   *  `file` content part), callers just pass the base64. */
  document?: { base64: string; filename?: string }
  /** M28 Part 3 — images to analyze alongside the first user message. Each
   *  provider attaches them in its native vision format (Anthropic `image`
   *  block, OpenAI-style `image_url` data URL, Gemini `inlineData`). Callers
   *  gate on vision capability first — see resolveChain({ needsVision }). */
  images?: { mimeType: string; base64: string }[]
  signal?: AbortSignal
}

export interface AIUsage {
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
}

export interface AICompletionResult {
  text: string
  toolInput?: Record<string, unknown>
  /** The concrete model that actually answered (e.g. 'claude-sonnet-4-6',
   *  'gpt-5.4') — for display/record-keeping on the saved result, not for
   *  callers to branch logic on. */
  model: string
  usage: AIUsage
}

export interface AIStreamResult extends AsyncIterable<{ delta: string }> {
  usage: Promise<AIUsage>
}

export type AIValidateKeyResult = { ok: true; models: string[] } | { ok: false; reason: string }

export interface AIProvider {
  readonly id: AIProviderId
  readonly displayName: string
  complete(req: AICompletionRequest): Promise<AICompletionResult>
  stream(req: AICompletionRequest): AIStreamResult
  validateKey(key: string): Promise<AIValidateKeyResult>
  listModels(): Promise<string[]>
}

/** Uniform failure shape every call site already expects (mirrors the old
 *  per-file `friendlyError` helpers this replaces) — `error` is a stable
 *  code for programmatic handling, `message` is what a rep actually reads.
 *  'model-not-found' and 'timeout' are M20 additions — completeWithFallback()
 *  advances the chain on either of these, same as 'rate-limit'/'network'. */
export type AIProviderErrorCode =
  'no-key' | 'auth' | 'rate-limit' | 'network' | 'failed' | 'model-not-found' | 'timeout'

/** BUG-057 Phase 2 — HOW a failure behaves over time, distinct from
 *  AIProviderErrorCode (WHAT shape it took). Drives cooldown SHAPE
 *  (model-cooldown.ts) and message copy (AllModelsExhaustedError).
 *  - 'transient': clears on its own in seconds-minutes — network blip, a
 *    per-minute rate-limit window, a provider 5xx.
 *  - 'period-exhausted': clears on a clock the account doesn't control
 *    minute-to-minute (daily/monthly free-tier cap, credits exhausted).
 *    Retrying inside the window is pure waste.
 *  - 'structural': will not succeed for this exact request shape against
 *    this exact model without a config change (a 400/tool-schema mismatch,
 *    a delisted model, an auth failure). */
export type AIFailureClass = 'transient' | 'period-exhausted' | 'structural'

/** BUG-057 Phase 5 / BUG-058 — which kind of caller is asking, for every
 *  mechanism that treats 'live' and 'durable' differently: model-cooldown.ts's
 *  tiered bypass (a durable caller may bypass a live-caused cooldown, never
 *  the reverse) and model-pacing.ts's cross-purpose pacing (only durable
 *  callers are paced, and only by another durable caller's recent use).
 *  Declared once, here, so both modules import the same concept instead of
 *  each declaring their own — model-cooldown.ts calls into model-pacing.ts
 *  internally (see isUsableFor), so this also avoids a circular import
 *  between the two. 'live' = CHAIN_BUDGET purposes (coaching-cue,
 *  deal-tier1) with single-digit-second total budgets; 'durable' = everyone
 *  else. */
export type CooldownTier = 'live' | 'durable'

export class AIProviderError extends Error {
  constructor(
    readonly code: AIProviderErrorCode,
    message: string,
    /** BUG-058 — how long the provider explicitly asked us to wait, in ms,
     *  when it told us at all (Retry-After header on OpenAI-compatible
     *  providers; RetryInfo.retryDelay in Gemini's error body). Free tiers
     *  rate-limit aggressively but recover in seconds, and this is the
     *  difference between waiting the ~20s they asked for and burning every
     *  other provider's quota in the meantime. Undefined when the provider
     *  gave no hint — callers fall back to their own default. */
    readonly retryAfterMs?: number,
    /** BUG-057 Phase 2 — set via failure-class.ts's classifyFailureClass()
     *  at the point a provider adapter constructs this error, where the raw
     *  message/status are still available. Undefined at call sites with
     *  nothing to classify from (validateKey's probe, the AbortError branch
     *  in completeWithSameModelRetry) — effectiveFailureClass() treats
     *  undefined as 'transient', not the most severe class: an ambiguous
     *  failure should default to whichever class self-heals fastest even on
     *  a wrong guess, not to the one that's hardest to recover from. */
    readonly failureClass?: AIFailureClass,
    /** BUG-058 Phase 3 — when the underlying QUOTA actually resets, epoch ms.
     *  Deliberately separate from retryAfterMs: that answers "how long until
     *  worth retrying" (short, drives cooldown DURATION); this answers "when
     *  does the account-level cap actually clear" (potentially much longer,
     *  drives MESSAGING only — see purpose-health.ts's messageFor). Set only
     *  where a real signal exists: a provider's own reset header/field
     *  (Anthropic, OpenRouter), or a provider's documented FIXED reset
     *  schedule computed from `now` (Groq: midnight UTC; Gemini: midnight
     *  Pacific) when the failure is already classified period-exhausted —
     *  never a guess. Undefined everywhere else, including every ordinary
     *  (non-period-exhausted) rate limit: an honest "we don't know" beats a
     *  number that looks precise and isn't. See
     *  docs/BUG-058-shared-resource-pacing-design.md §3 for the per-provider
     *  research this is built from. */
    readonly resetsAt?: number
  ) {
    super(message)
    this.name = 'AIProviderError'
  }
}

export function effectiveFailureClass(err: AIProviderError): AIFailureClass {
  return err.failureClass ?? 'transient'
}

/** Per-purpose latency policy — M9 fixed live-coaching latency with
 *  maxRetries:0 on the Anthropic client; this makes that non-negotiable and
 *  applies identically to whichever provider is active. NEVER let a retry
 *  loop reintroduce itself on the coaching-cue path — a test asserts this
 *  (see __tests__/latencyPolicy.test.ts).
 *
 *  BUG-058/BUG-059 — `maxRetries` USED TO live on this interface and
 *  configured the provider SDK's own internal retry. It was removed, not
 *  renamed: the SDK's retry slept on an uncapped, unabortable wait driven by
 *  the provider's own header (see providers/*.ts's own comments), and every
 *  SDK call site now hardcodes `maxRetries: 0` — the SDK never retries
 *  again. Retry budget is now SAME_MODEL_RETRY_LIMIT below, spent by
 *  completeWithFallback's own abortable loop. Leaving a `maxRetries` field
 *  here that nothing read would have been exactly the kind of lie BUG-060's
 *  own inverted default exists to prevent — a number that looks load-bearing
 *  and isn't. */
export interface LatencyPolicyEntry {
  timeoutMs: number
}

export const LATENCY_POLICY: Record<AIPurpose, LatencyPolicyEntry> = {
  'coaching-cue': { timeoutMs: 6_000 },
  summary: { timeoutMs: 60_000 },
  scorecard: { timeoutMs: 60_000 },
  tasks: { timeoutMs: 30_000 },
  other: { timeoutMs: 30_000 },
  // No consumer yet (M19 Task 3B not built) - same shape as 'other' until a
  // real call site exists to tell us its actual latency needs.
  'prep-brief': { timeoutMs: 30_000 },
  // M24's own acceptance criterion is "trigger to visible cue in <=4s" for
  // the WHOLE round trip (Tier 0 detection + this call + Nudge Engine
  // gating, all effectively instant except this). 0 retries for the same
  // reason as coaching-cue - a late deal-risk nudge is worse than a missed
  // one, since the moment it was actually relevant has usually passed.
  'deal-tier1': { timeoutMs: 4_000 },
  // Runs every 2-3 minutes, not per-turn - not latency-critical the same way
  // deal-tier1 is, so it gets the same tier as summary/scorecard.
  'deal-tier2': { timeoutMs: 60_000 },
  // Interactive but not real-time the way coaching-cue is — the rep is
  // watching a stream fill in, not waiting on one blocking round-trip, so a
  // slightly shorter timeout than summary/scorecard (still generous) plus
  // one retry is the right shape. streamWithFallback() only ever retries
  // BEFORE any token has reached the renderer (see its own doc comment).
  'coaching-chat': { timeoutMs: 45_000 },
  // Post-call/post-chat background job, never blocks a UI the user is
  // watching — generous timeout is fine, but capped (not summary/scorecard's
  // full 60s) since extraction is a small, fixed-shape allowlist pull, not
  // deep reasoning.
  'memory-extract': { timeoutMs: 20_000 },
  // Nightly/background judgment work, same tier as summary/scorecard — a
  // real conversation-quality decision (is this a duplicate? a
  // contradiction? a genuine cross-memory pattern?), never watched live.
  'memory-consolidate': { timeoutMs: 60_000 },
  'memory-reflect': { timeoutMs: 60_000 },
  // M28 — same interactive-streaming tier as 'coaching-chat', same reasoning:
  // the rep watches a stream fill in, so a per-attempt timeout below
  // summary/scorecard's plus streamWithFallback's pre-first-delta retry.
  'assistant-chat': { timeoutMs: 45_000 }
}

/**
 * BUG-058/BUG-059 — how many times completeWithFallback's own loop retries
 * the SAME model, for a network/timeout failure, before moving on. Replaces
 * the old per-purpose `LATENCY_POLICY.maxRetries`, deliberately NOT by
 * reusing those numbers unexamined — they were tuned for a different
 * mechanism (the SDK's own broader default retry predicate, with its own,
 * often header-driven, backoff) and were never checked against
 * HARD_CEILING_MS, the thing that now actually bounds a step's total time.
 *
 * Checked, not assumed: `(1 + oldMaxRetries) * timeoutMs` against
 * HARD_CEILING_MS for every purpose. For summary/scorecard/deal-tier2/
 * memory-consolidate/memory-reflect it came out to EXACTLY the ceiling
 * (180s worst-case single-step against a 180s ceiling) — meaning one
 * model's own retries could consume the entire ceiling budget, leaving
 * ZERO room for the cross-model fallback this whole milestone exists to
 * provide. A uniform cap of 1 leaves 30–120s of margin for every purpose
 * (computed against the SAME ceiling table) — a second same-model retry is
 * low value anyway: if a model timed out AND timed out again, a third
 * attempt at the identical model is a worse use of the remaining budget
 * than trying a genuinely different one, which the chain already offers.
 *
 * 0 for coaching-cue/deal-tier1 — unchanged from before, and provably
 * zero-risk: LEGACY_TAIL_MAX is also 0 for both (BUG-057), so these two
 * purposes are single-attempt by design end to end, matching the
 * <=4s/<=6s live-latency criteria M9/M24 fixed. Exhaustive Record, not
 * Partial, for the same reason LEGACY_TAIL_MAX/HARD_CEILING_MS are — a
 * 13th purpose must force a decision here, not inherit one silently.
 */
export const SAME_MODEL_RETRY_LIMIT: Record<AIPurpose, number> = {
  'coaching-cue': 0,
  'deal-tier1': 0,
  summary: 1,
  scorecard: 1,
  tasks: 1,
  other: 1,
  'prep-brief': 1,
  'deal-tier2': 1,
  'coaching-chat': 1,
  'memory-extract': 1,
  'memory-consolidate': 1,
  'memory-reflect': 1,
  'assistant-chat': 1
}

/** Total wall-clock budget for a whole completeWithFallback() chain on this
 *  purpose, and the max number of chain entries it may contain. Only
 *  'coaching-cue' is capped today - M9 already fixed one multi-second
 *  dead-air regression on this exact path (see docs/ai-providers.md), and a
 *  naive chain walk giving each entry its own full LATENCY_POLICY timeout
 *  would reintroduce a worse version of it (a 3-entry chain under bad
 *  network conditions -> 18s of dead air). completeWithFallback() splits
 *  `totalBudgetMs` across whatever chain length is configured (capped at
 *  `maxChainLength`) via a per-attempt AbortController deadline, instead of
 *  giving every attempt the full LATENCY_POLICY timeout independently.
 *  Other purposes are post-call, not time-critical the same way, so they
 *  keep using LATENCY_POLICY's per-attempt timeout uncapped. */
export interface ChainBudget {
  totalBudgetMs: number
  maxChainLength: number
}

export const CHAIN_BUDGET: Partial<Record<AIPurpose, ChainBudget>> = {
  'coaching-cue': { totalBudgetMs: LATENCY_POLICY['coaching-cue'].timeoutMs, maxChainLength: 2 },
  'deal-tier1': { totalBudgetMs: LATENCY_POLICY['deal-tier1'].timeoutMs, maxChainLength: 2 }
}

/**
 * BUG-059 — a HARD wall-clock ceiling on one completeWithFallback() call,
 * covering the whole chain walk INCLUDING each provider SDK's own internal
 * retries.
 *
 * Why a crude backstop rather than part of the proper budget design: today
 * two independently-bounded loops multiply with nothing bounding the product.
 * Our loop is bounded by chain length; each SDK's retry loop is bounded by
 * LATENCY_POLICY.maxRetries; NOTHING bounds chain x retries x timeout. For
 * `summary` that is 9 entries x 3 attempts x 60s ~= 27 MINUTES of a user
 * watching a spinner before being told it failed.
 *
 * CHAIN_BUDGET does not save us: it exists for exactly two purposes
 * ('coaching-cue', 'deal-tier1'), and both are maxRetries:0 — so it has never
 * had to bound an SDK retry loop at all. Every purpose that DOES retry has no
 * budget whatsoever.
 *
 * And it could not be cancelled out of: JobManager hands every executor an
 * AbortSignal and its own doc comment says adapters MUST thread it into
 * `req.signal` "for cancel to mean anything" — no adapter does, so pressing
 * Cancel removed the job from the UI while the loop kept running and kept
 * spending quota.
 *
 * These values are CHOSEN, not sourced: generous enough that a legitimately
 * slow chain still finishes (a real summary attempt can use most of its 60s
 * timeout, and a model or two may fail first), tight enough that nothing
 * approaches the pathological case. Deliberately blunt — a backstop, not the
 * eventual shared-budget design, and it must stay correct even if that design
 * changes underneath it.
 */
export const HARD_CEILING_MS: Record<AIPurpose, number> = {
  // Live paths: CHAIN_BUDGET already bounds these tightly. The ceiling sits
  // just above it purely as a backstop and should never be what fires.
  'coaching-cue': 10_000,
  'deal-tier1': 8_000,
  // A human is blocked on these.
  other: 90_000,
  'coaching-chat': 120_000,
  // M28 — a human is blocked on this, same tier as coaching-chat. Checked the
  // same way SAME_MODEL_RETRY_LIMIT's comment demands: (1+1) × 45s worst-case
  // single step against a 120s ceiling leaves 30s of cross-model margin.
  'assistant-chat': 120_000,
  tasks: 120_000,
  'memory-extract': 120_000,
  // Background/post-call: a progress chip is watching, nobody is blocked.
  summary: 180_000,
  scorecard: 180_000,
  'prep-brief': 180_000,
  'deal-tier2': 180_000,
  'memory-consolidate': 180_000,
  'memory-reflect': 180_000
}
