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

export type AIProviderId = 'anthropic' | 'openai'

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
}

/** What the call is FOR — this drives model selection (each provider maps
 *  purpose -> its own concrete model) and the latency policy below, so
 *  call sites never hardcode a model string or a retry/timeout value. */
export type AIPurpose = 'coaching-cue' | 'summary' | 'scorecard' | 'tasks' | 'other'

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
 *  code for programmatic handling, `message` is what a rep actually reads. */
export type AIProviderErrorCode = 'no-key' | 'auth' | 'rate-limit' | 'network' | 'failed'

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
  other: { maxRetries: 1, timeoutMs: 30_000 }
}
