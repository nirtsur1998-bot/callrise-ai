// M20: one factory for every provider that speaks the OpenAI Chat Completions
// wire format at a custom base URL (Groq, OpenRouter, NVIDIA NIM, Cerebras,
// Mistral) instead of five near-duplicate provider files. Modeled on
// providers/openai.ts (see that file for the "why Chat Completions, not
// Responses" reasoning, which applies identically here) — this file exists
// so a 6th OpenAI-compatible provider is a config object, not a new file.
import OpenAI from 'openai'
import { classifyFailureClass } from '../failure-class'
import {
  AIProviderError,
  LATENCY_POLICY,
  type AICompletionRequest,
  type AICompletionResult,
  type AIProvider,
  type AIProviderId,
  type AIStreamResult,
  type AIUsage,
  type AIValidateKeyResult
} from '../types'

export interface OpenAICompatibleConfig {
  id: AIProviderId
  displayName: string
  baseURL: string
  /** Used when a caller never sets req.model (no M16-era call site will ever
   *  hit this for these six providers, but a direct/test call might). */
  defaultModel: string
  /** Cheapest/fastest model for the "Test key" 1-token round trip. Defaults
   *  to defaultModel when the provider doesn't need a distinct one. */
  testModel?: string
  /** Which max-tokens field name this provider's Chat Completions endpoint
   *  actually accepts. Defaults to `max_completion_tokens` (OpenAI's current
   *  field, and what Groq/OpenRouter/NVIDIA/Cerebras all accept). Mistral's
   *  API only recognizes the older `max_tokens` and 422s the ENTIRE request
   *  on an unrecognized field ("Extra inputs are not permitted") — found in
   *  the M22 bug hunt: this meant every Mistral completion (and "Test key",
   *  which sends the same request shape) failed deterministically, the same
   *  class of bug as the Gemini schema-field issue fixed earlier the same
   *  session, just a request PARAMETER instead of a tool SCHEMA field. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
}

/** Best-effort x-ratelimit-* snapshot per provider, for Settings display
 *  only. NEVER read by completeWithFallback() to decide anything — advance-
 *  on-failure is keyed off the thrown AIProviderError code, which is uniform
 *  across providers; these headers are not (OpenRouter's own docs say they
 *  only appear on OpenRouter-generated errors, not successful responses;
 *  Cerebras/NVIDIA/Mistral header behavior is unconfirmed - treat absence as
 *  "unknown", never as "zero remaining"). */
export interface RateLimitSnapshot {
  limitRequests?: number
  remainingRequests?: number
  limitTokens?: number
  remainingTokens?: number
  observedAt: string
}

const rateLimitCache = new Map<AIProviderId, RateLimitSnapshot>()

export function getRateLimitSnapshot(id: AIProviderId): RateLimitSnapshot | null {
  return rateLimitCache.get(id) ?? null
}

function captureRateLimitHeaders(id: AIProviderId, headers: Headers): void {
  const num = (name: string): number | undefined => {
    const raw = headers.get(name)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? n : undefined
  }
  const snapshot: RateLimitSnapshot = {
    limitRequests: num('x-ratelimit-limit-requests'),
    remainingRequests: num('x-ratelimit-remaining-requests'),
    limitTokens: num('x-ratelimit-limit-tokens'),
    remainingTokens: num('x-ratelimit-remaining-tokens'),
    observedAt: new Date().toISOString()
  }
  const hasAny =
    snapshot.limitRequests !== undefined ||
    snapshot.remainingRequests !== undefined ||
    snapshot.limitTokens !== undefined ||
    snapshot.remainingTokens !== undefined
  if (hasAny) rateLimitCache.set(id, snapshot)
}

function toMessages(req: AICompletionRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  req.messages.forEach((m, i) => {
    if ((req.document || req.images?.length) && i === 0 && m.role === 'user') {
      const parts: OpenAI.Chat.ChatCompletionContentPart[] = []
      // M28 Part 3 — images as data-URL image parts (the OpenAI-compatible
      // vision shape Groq's Llama 4 Scout accepts), then any document, then text.
      for (const img of req.images ?? []) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
        })
      }
      if (req.document) {
        parts.push({
          type: 'file',
          file: {
            file_data: `data:application/pdf;base64,${req.document.base64}`,
            filename: req.document.filename ?? 'document.pdf'
          }
        })
      }
      parts.push({ type: 'text', text: m.content })
      messages.push({ role: 'user', content: parts })
      return
    }
    messages.push({ role: m.role, content: m.content })
  })
  return messages
}

function toTools(req: AICompletionRequest): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!req.tool) return undefined
  return [
    {
      type: 'function',
      function: {
        name: req.tool.name,
        description: req.tool.description,
        parameters: req.tool.inputSchema
      }
    }
  ]
}

function toToolChoice(
  req: AICompletionRequest
): OpenAI.Chat.ChatCompletionToolChoiceOption | undefined {
  return req.tool ? { type: 'function', function: { name: req.tool.name } } : undefined
}

function parseToolInput(message: OpenAI.Chat.ChatCompletionMessage): Record<string, unknown> {
  const call = message.tool_calls?.[0]
  if (!call || call.type !== 'function') {
    throw new AIProviderError('failed', 'The model did not return the expected structured output.')
  }
  try {
    return JSON.parse(call.function.arguments) as Record<string, unknown>
  } catch {
    throw new AIProviderError('failed', 'The model returned malformed structured output.')
  }
}

// No per-model pricing table: every catalog entry these providers serve
// (see ai/model-catalog.ts) is a free tier - estimatedCostUsd is always 0
// rather than an invented number.
function usageFrom(inputTokens: number, outputTokens: number): AIUsage {
  return { inputTokens, outputTokens, estimatedCostUsd: 0 }
}

/**
 * BUG-058 — the provider's own "come back in N seconds", in ms.
 *
 * Reads `retry-after-ms` (OpenAI/Groq send it, and it is the precise one)
 * before `retry-after` (seconds, or an HTTP-date). Without this the app has
 * no idea whether a 429 clears in 2 seconds or 2 hours, so it treated both as
 * "this model is dead, move on" and burned the whole chain.
 *
 * Exported for direct unit testing, same reasoning as resolveMaxTokensField.
 */
export function retryAfterMsFrom(err: unknown): number | undefined {
  const headers = (err as { headers?: unknown })?.headers
  if (!headers) return undefined
  const get = (name: string): string | null => {
    if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name)
    const rec = headers as Record<string, string | undefined>
    return rec[name] ?? rec[name.toLowerCase()] ?? null
  }

  const ms = get('retry-after-ms')
  if (ms) {
    const n = Number(ms)
    if (Number.isFinite(n) && n > 0) return n
  }

  const secs = get('retry-after')
  if (secs) {
    const n = Number(secs)
    if (Number.isFinite(n) && n > 0) return n * 1000
    // RFC-permitted HTTP-date form.
    const at = Date.parse(secs)
    if (!Number.isNaN(at)) {
      const delta = at - Date.now()
      if (delta > 0) return delta
    }
  }
  return undefined
}

/**
 * BUG-058 Phase 3 — the underlying quota's real (or documented-fixed-
 * schedule) reset time, for messaging only (see AIProviderError.resetsAt's
 * own doc comment — separate concept from retryAfterMsFrom's short-term
 * hint). Only called once a failure is ALREADY classified period-exhausted:
 * an ordinary per-minute 429 has nothing to do with a daily clock.
 *
 * - OpenRouter: `X-RateLimit-Reset`, a real Unix-MS timestamp on rate-limit
 *   error responses — read directly, no computation, no guessing.
 * - Groq: no live header exists for the DAILY cap specifically (Groq's own
 *   docs: track it yourself, it resets at a fixed midnight UTC) — computed
 *   here from `now`, and labeled in this function's own name/doc as a
 *   documented schedule, not a parsed value, so a future Groq policy change
 *   reads as a stale assumption here, not a parsing bug.
 * - NVIDIA/Cerebras/Mistral: unconfirmed by this session's research —
 *   returns undefined, the honest default, same as no signal at all.
 *
 * Exported for direct unit testing, same reasoning as retryAfterMsFrom.
 */
export function resetsAtFrom(providerId: AIProviderId, err: unknown, now: number): number | undefined {
  if (providerId === 'openrouter') {
    const headers = (err as { headers?: unknown })?.headers
    if (!headers) return undefined
    const get = (name: string): string | null =>
      typeof (headers as Headers).get === 'function'
        ? (headers as Headers).get(name)
        : ((headers as Record<string, string | undefined>)[name] ?? null)
    const raw = get('x-ratelimit-reset')
    if (!raw) return undefined
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  if (providerId === 'groq') {
    const next = new Date(now)
    return Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate() + 1, 0, 0, 0, 0)
  }
  return undefined
}

/** Exported for direct unit testing, same reasoning as resolveMaxTokensField
 *  below — asserting on error mapping shouldn't require standing up a real
 *  OpenAI client. `providerId` distinguishes which of the six providers this
 *  config instance is (BUG-058 Phase 3 — resetsAtFrom needs to know, since
 *  only Groq/OpenRouter currently have a real-or-documented reset signal). */
export function toProviderError(
  displayName: string,
  providerId: AIProviderId,
  err: unknown
): AIProviderError {
  if (err instanceof OpenAI.AuthenticationError) {
    return new AIProviderError('auth', `Your ${displayName} API key was rejected.`, undefined, 'structural')
  }
  if (err instanceof OpenAI.RateLimitError) {
    const msg = typeof err.message === 'string' ? err.message : ''
    const failureClass = classifyFailureClass('rate-limit', { message: msg, status: err.status ?? undefined })
    return new AIProviderError(
      'rate-limit',
      `${displayName} is rate-limiting requests right now.`,
      retryAfterMsFrom(err),
      failureClass,
      failureClass === 'period-exhausted' ? resetsAtFrom(providerId, err, Date.now()) : undefined
    )
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new AIProviderError(
      'model-not-found',
      `${displayName} does not recognize this model.`,
      undefined,
      'structural'
    )
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError || err instanceof OpenAI.APIUserAbortError) {
    // APIUserAbortError fires when an AbortSignal we passed in aborts - in
    // this codebase that's always completeWithFallback()'s per-attempt
    // budget timeout (see complete-with-fallback.ts), never a user-initiated
    // cancel, so 'timeout' is the accurate classification here.
    return new AIProviderError('timeout', `${displayName} did not respond in time.`)
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new AIProviderError(
      'network',
      `Could not reach ${displayName}. Check your internet connection.`
    )
  }
  if (err instanceof OpenAI.APIError) {
    const msg = typeof err.message === 'string' ? err.message.toLowerCase() : ''
    if (msg.includes('quota') || msg.includes('billing') || msg.includes('credit')) {
      return new AIProviderError(
        'failed',
        `Your ${displayName} account is out of quota/credits.`,
        undefined,
        'period-exhausted'
      )
    }
    if (err.status === 429) {
      const failureClass = classifyFailureClass('rate-limit', { message: msg, status: err.status ?? undefined })
      return new AIProviderError(
        'rate-limit',
        `${displayName} is rate-limiting requests right now.`,
        retryAfterMsFrom(err),
        failureClass,
        failureClass === 'period-exhausted' ? resetsAtFrom(providerId, err, Date.now()) : undefined
      )
    }
    if (err.status === 404) {
      return new AIProviderError(
        'model-not-found',
        `${displayName} does not recognize this model.`,
        undefined,
        'structural'
      )
    }
    // BUG-057 — KEEP the provider's own message. This used to return only
    // "<provider> returned an error (400)." and throw err.message away, which
    // is why two days of chain-exhaustion logs could not answer the only
    // question that mattered: WHY. A 400 is the provider telling us the
    // request was rejected and usually saying exactly what was wrong with it
    // (Groq, for instance, returns 400 with code `tool_use_failed` when a
    // model cannot produce a valid function call — indistinguishable from a
    // malformed-schema 400 unless the text survives).
    //
    // Same reasoning as this file's own Mistral `max_tokens` and Gemini
    // schema-field bugs: both were structural 400s on every single request,
    // and both were found only once someone read the real error text.
    const detail = typeof err.message === 'string' ? err.message.trim() : ''

    // M27 — the case the comment above named but never wired up. Confirmed
    // live: Sales Brain's import hit "400 Failed to parse tool call
    // arguments as JSON" from Groq (code `tool_use_failed`) and it got
    // classified 'structural' — the generic status>=400 fallthrough below —
    // which excludes the model for STRUCTURAL_BREAK_MS (4h) on a single
    // occurrence.
    //
    // That classification fits a request the provider will ALWAYS reject
    // (a bad parameter, an unsupported field). This isn't that: it's the
    // MODEL's own generation coming out malformed, which is sampling-
    // dependent — the identical request retried a moment later plausibly
    // produces valid JSON. Treating a nondeterministic hiccup as a
    // deterministic rejection is what let one flaky generation take out a
    // whole link in an already-thin free-tier chain, compounding exactly
    // the "everything falls through to the one surviving model" problem
    // BUG-066/B2 exist to prevent.
    //
    // `err.code`, not a message-text match: the OpenAI-compatible SDK
    // parses the provider's own JSON error code into this field, so this is
    // exact rather than a fragile substring guess on wording that could
    // change.
    if (err.code === 'tool_use_failed') {
      return new AIProviderError(
        'failed',
        detail
          ? `${displayName} could not format a valid response for this request (usually resolves on retry): ${detail.slice(0, 300)}`
          : `${displayName} could not format a valid response for this request (usually resolves on retry).`,
        undefined,
        'transient'
      )
    }

    return new AIProviderError(
      'failed',
      detail
        ? `${displayName} returned an error (${err.status ?? 'unknown'}): ${detail.slice(0, 300)}`
        : `${displayName} returned an error (${err.status ?? 'unknown'}).`,
      undefined,
      classifyFailureClass('failed', { message: msg, status: err.status ?? undefined })
    )
  }
  return new AIProviderError('failed', `Something went wrong calling ${displayName}. Please try again.`)
}

/** The one max-tokens field a given provider config actually accepts, as a
 *  spreadable object — see OpenAICompatibleConfig.maxTokensParam's doc
 *  comment. A standalone function (not a class method) so it's testable
 *  without standing up a real OpenAI client, the same way toGeminiSchema is. */
export function resolveMaxTokensField(
  config: Pick<OpenAICompatibleConfig, 'maxTokensParam'>,
  maxTokens: number
): Record<string, number> {
  return { [config.maxTokensParam ?? 'max_completion_tokens']: maxTokens }
}

class OpenAICompatibleProvider implements AIProvider {
  readonly id: AIProviderId
  readonly displayName: string
  private client: OpenAI
  private config: OpenAICompatibleConfig

  constructor(config: OpenAICompatibleConfig, apiKey: string) {
    this.config = config
    this.id = config.id
    this.displayName = config.displayName
    this.client = new OpenAI({ apiKey, baseURL: config.baseURL })
  }

  private maxTokensField(maxTokens: number): Record<string, number> {
    return resolveMaxTokensField(this.config, maxTokens)
  }

  async complete(req: AICompletionRequest): Promise<AICompletionResult> {
    const policy = LATENCY_POLICY[req.purpose]
    const model = req.model ?? this.config.defaultModel
    try {
      const { data: response, response: rawResponse } = await this.client.chat.completions
        .create(
          {
            model,
            ...this.maxTokensField(req.maxTokens),
            temperature: req.temperature,
            messages: toMessages(req),
            tools: toTools(req),
            tool_choice: toToolChoice(req)
          },
          // BUG-058/BUG-059 — maxRetries is ALWAYS the literal 0, never a variable.
          // The SDK's own internal retry sleep (internal/utils/sleep.js) is a bare
          // `setTimeout(ms)` that never accepts a signal, and `ms` is taken directly
          // from the provider's Retry-After header with NO CAP (client.js's
          // calculateRetryTimeoutMs). A 429 with a large hint made the SDK sleep,
          // uninterruptibly, for however long the header said — bypassing
          // HARD_CEILING_MS entirely AND bypassing model-cooldown.ts's
          // markRateLimited(), since that can't fire until this call returns. Verified
          // by reading the vendored source, not assumed. completeWithFallback's own
          // walker now owns every retry decision (see its RETRYABLE_REASONS), fully
          // abortable and cooldown-aware, which the SDK's internal loop was neither.
          { timeout: policy.timeoutMs, maxRetries: 0, signal: req.signal }
        )
        .withResponse()
      captureRateLimitHeaders(this.id, rawResponse.headers)
      const message = response.choices[0]?.message
      const usage = usageFrom(response.usage?.prompt_tokens ?? 0, response.usage?.completion_tokens ?? 0)
      if (!message) throw new AIProviderError('failed', `${this.displayName} returned no response.`)
      if (req.tool) return { text: '', toolInput: parseToolInput(message), model, usage }
      return { text: message.content ?? '', model, usage }
    } catch (err) {
      if (err instanceof AIProviderError) throw err
      throw toProviderError(this.displayName, this.id, err)
    }
  }

  stream(req: AICompletionRequest): AIStreamResult {
    const policy = LATENCY_POLICY[req.purpose]
    const model = req.model ?? this.config.defaultModel
    const client = this.client
    const displayName = this.displayName
    const providerId = this.id
    const maxTokensField = this.maxTokensField(req.maxTokens)

    let resolveUsage: (u: AIUsage) => void
    const usage = new Promise<AIUsage>((resolve) => {
      resolveUsage = resolve
    })

    async function* generator(): AsyncGenerator<{ delta: string }> {
      try {
        const stream = await client.chat.completions.create(
          {
            model,
            ...maxTokensField,
            temperature: req.temperature,
            messages: toMessages(req),
            tools: toTools(req),
            tool_choice: toToolChoice(req),
            stream: true,
            stream_options: { include_usage: true }
          },
          // BUG-058/BUG-059 — maxRetries is ALWAYS the literal 0, never a variable.
          // The SDK's own internal retry sleep (internal/utils/sleep.js) is a bare
          // `setTimeout(ms)` that never accepts a signal, and `ms` is taken directly
          // from the provider's Retry-After header with NO CAP (client.js's
          // calculateRetryTimeoutMs). A 429 with a large hint made the SDK sleep,
          // uninterruptibly, for however long the header said — bypassing
          // HARD_CEILING_MS entirely AND bypassing model-cooldown.ts's
          // markRateLimited(), since that can't fire until this call returns. Verified
          // by reading the vendored source, not assumed. completeWithFallback's own
          // walker now owns every retry decision (see its RETRYABLE_REASONS), fully
          // abortable and cooldown-aware, which the SDK's internal loop was neither.
          { timeout: policy.timeoutMs, maxRetries: 0, signal: req.signal }
        )
        let inputTokens = 0
        let outputTokens = 0
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content
          if (delta) yield { delta }
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens
            outputTokens = chunk.usage.completion_tokens
          }
        }
        resolveUsage(usageFrom(inputTokens, outputTokens))
      } catch (err) {
        resolveUsage({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
        throw err instanceof AIProviderError ? err : toProviderError(displayName, providerId, err)
      }
    }

    const iterable = generator()
    return Object.assign(iterable, { usage })
  }

  async validateKey(key: string): Promise<AIValidateKeyResult> {
    try {
      const probe = new OpenAI({ apiKey: key, baseURL: this.config.baseURL })
      await probe.chat.completions.create(
        {
          model: this.config.testModel ?? this.config.defaultModel,
          ...this.maxTokensField(1),
          messages: [{ role: 'user', content: 'hi' }]
        },
        { timeout: 10_000, maxRetries: 0 }
      )
      return { ok: true, models: await this.listModels() }
    } catch (err) {
      const providerErr = toProviderError(this.displayName, this.id, err)
      return { ok: false, reason: providerErr.message }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const page = await this.client.models.list()
      const ids: string[] = []
      for await (const model of page) ids.push(model.id)
      return ids
    } catch {
      // /models unreachable or unsupported by this provider - the catalog's
      // resolveCatalog() treats this as "can't confirm, assume available"
      // rather than punishing a transient hiccup.
      return [this.config.defaultModel]
    }
  }
}

export function createOpenAICompatibleProvider(
  config: OpenAICompatibleConfig,
  apiKey: string
): AIProvider {
  return new OpenAICompatibleProvider(config, apiKey)
}
