// M20: one factory for every provider that speaks the OpenAI Chat Completions
// wire format at a custom base URL (Groq, OpenRouter, NVIDIA NIM, Cerebras,
// Mistral) instead of five near-duplicate provider files. Modeled on
// providers/openai.ts (see that file for the "why Chat Completions, not
// Responses" reasoning, which applies identically here) — this file exists
// so a 6th OpenAI-compatible provider is a config object, not a new file.
import OpenAI from 'openai'
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
    if (req.document && i === 0 && m.role === 'user') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'file',
            file: {
              file_data: `data:application/pdf;base64,${req.document.base64}`,
              filename: req.document.filename ?? 'document.pdf'
            }
          },
          { type: 'text', text: m.content }
        ]
      })
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

function toProviderError(displayName: string, err: unknown): AIProviderError {
  if (err instanceof OpenAI.AuthenticationError) {
    return new AIProviderError('auth', `Your ${displayName} API key was rejected.`)
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new AIProviderError('rate-limit', `${displayName} is rate-limiting requests right now.`)
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new AIProviderError('model-not-found', `${displayName} does not recognize this model.`)
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
      return new AIProviderError('failed', `Your ${displayName} account is out of quota/credits.`)
    }
    if (err.status === 429) {
      return new AIProviderError('rate-limit', `${displayName} is rate-limiting requests right now.`)
    }
    if (err.status === 404) {
      return new AIProviderError('model-not-found', `${displayName} does not recognize this model.`)
    }
    return new AIProviderError('failed', `${displayName} returned an error (${err.status ?? 'unknown'}).`)
  }
  return new AIProviderError('failed', `Something went wrong calling ${displayName}. Please try again.`)
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

  async complete(req: AICompletionRequest): Promise<AICompletionResult> {
    const policy = LATENCY_POLICY[req.purpose]
    const model = req.model ?? this.config.defaultModel
    try {
      const { data: response, response: rawResponse } = await this.client.chat.completions
        .create(
          {
            model,
            max_completion_tokens: req.maxTokens,
            temperature: req.temperature,
            messages: toMessages(req),
            tools: toTools(req),
            tool_choice: toToolChoice(req)
          },
          { timeout: policy.timeoutMs, maxRetries: policy.maxRetries, signal: req.signal }
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
      throw toProviderError(this.displayName, err)
    }
  }

  stream(req: AICompletionRequest): AIStreamResult {
    const policy = LATENCY_POLICY[req.purpose]
    const model = req.model ?? this.config.defaultModel
    const client = this.client
    const displayName = this.displayName

    let resolveUsage: (u: AIUsage) => void
    const usage = new Promise<AIUsage>((resolve) => {
      resolveUsage = resolve
    })

    async function* generator(): AsyncGenerator<{ delta: string }> {
      try {
        const stream = await client.chat.completions.create(
          {
            model,
            max_completion_tokens: req.maxTokens,
            temperature: req.temperature,
            messages: toMessages(req),
            tools: toTools(req),
            tool_choice: toToolChoice(req),
            stream: true,
            stream_options: { include_usage: true }
          },
          { timeout: policy.timeoutMs, maxRetries: policy.maxRetries, signal: req.signal }
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
        throw err instanceof AIProviderError ? err : toProviderError(displayName, err)
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
          max_completion_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        },
        { timeout: 10_000, maxRetries: 0 }
      )
      return { ok: true, models: await this.listModels() }
    } catch (err) {
      const providerErr = toProviderError(this.displayName, err)
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
