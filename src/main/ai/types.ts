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

/** 'anthropic'/'openai' are the original M16 pair. The other six are M20's
 *  addition — five OpenAI-Chat-Completions-compatible providers (each built
 *  by providers/openai-compatible.ts, parameterised by base URL) plus
 *  'google' (Gemini, its own REST adapter — not OpenAI-compatible). */
export type AIProviderId =
  'anthropic' | 'openai' | 'groq' | 'openrouter' | 'google' | 'nvidia' | 'cerebras' | 'mistral'

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
 *  can afford to think longer, same tier as 'summary'/'scorecard'. */
export type AIPurpose =
  | 'coaching-cue'
  | 'summary'
  | 'scorecard'
  | 'tasks'
  | 'other'
  | 'prep-brief'
  | 'deal-tier1'
  | 'deal-tier2'

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

export class AIProviderError extends Error {
  constructor(
    readonly code: AIProviderErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'AIProviderError'
  }
}

/** Per-purpose latency policy — M9 fixed live-coaching latency with
 *  maxRetries:0 on the Anthropic client; this makes that non-negotiable and
 *  applies identically to whichever provider is active. NEVER let a retry
 *  loop reintroduce itself on the coaching-cue path — a test asserts this
 *  (see __tests__/latencyPolicy.test.ts). */
export interface LatencyPolicyEntry {
  maxRetries: number
  timeoutMs: number
}

export const LATENCY_POLICY: Record<AIPurpose, LatencyPolicyEntry> = {
  'coaching-cue': { maxRetries: 0, timeoutMs: 6_000 },
  summary: { maxRetries: 2, timeoutMs: 60_000 },
  scorecard: { maxRetries: 2, timeoutMs: 60_000 },
  tasks: { maxRetries: 2, timeoutMs: 30_000 },
  other: { maxRetries: 1, timeoutMs: 30_000 },
  // No consumer yet (M19 Task 3B not built) - same shape as 'other' until a
  // real call site exists to tell us its actual latency needs.
  'prep-brief': { maxRetries: 1, timeoutMs: 30_000 },
  // M24's own acceptance criterion is "trigger to visible cue in <=4s" for
  // the WHOLE round trip (Tier 0 detection + this call + Nudge Engine
  // gating, all effectively instant except this). 0 retries for the same
  // reason as coaching-cue - a late deal-risk nudge is worse than a missed
  // one, since the moment it was actually relevant has usually passed.
  'deal-tier1': { maxRetries: 0, timeoutMs: 4_000 },
  // Runs every 2-3 minutes, not per-turn - not latency-critical the same way
  // deal-tier1 is, so it gets the same tier as summary/scorecard.
  'deal-tier2': { maxRetries: 2, timeoutMs: 60_000 }
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
