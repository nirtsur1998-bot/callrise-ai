import OpenAI from 'openai'
import { classifyFailureClass } from '../failure-class'
import {
  AIProviderError,
  LATENCY_POLICY,
  type AICompletionRequest,
  type AICompletionResult,
  type AIProvider,
  type AIPurpose,
  type AIStreamResult,
  type AIUsage,
  type AIValidateKeyResult
} from '../types'

// Chat Completions, not the newer Responses API: Responses is stateful/
// agentic-oriented (server-side conversation state, built-in tools) which
// none of our call sites need — every one of them is a single-turn,
// forced-tool-call request, the exact shape Chat Completions was built for,
// and it's the more stable/widely-documented surface for that.
//
// Model tiers, current as of this SDK's ChatModel union: gpt-5.4-mini for
// latency-sensitive/cheap work (mirrors Claude Haiku's role), gpt-5.4 for
// anything that can afford to think longer (mirrors Claude Sonnet's role).
const MODEL_BY_PURPOSE: Record<AIPurpose, string> = {
  'coaching-cue': 'gpt-5.4-mini',
  summary: 'gpt-5.4',
  scorecard: 'gpt-5.4',
  tasks: 'gpt-5.4',
  other: 'gpt-5.4',
  // No consumer yet (M19 Task 3B not built) - same tier as 'other'.
  'prep-brief': 'gpt-5.4',
  // M24 - same fast/cheap tier as coaching-cue; same latency-critical shape.
  'deal-tier1': 'gpt-5.4-mini',
  // M24 - can afford to think longer; same tier as summary/scorecard.
  'deal-tier2': 'gpt-5.4',
  // M23 Workstream B - quality tier; a real coaching conversation.
  'coaching-chat': 'gpt-5.4',
  // M25 - fast/cheap tier, same as coaching-cue; a small fixed-shape pull.
  'memory-extract': 'gpt-5.4-mini',
  // M25 Phase 2 - judgment work, quality tier same as summary/scorecard.
  'memory-consolidate': 'gpt-5.4',
  'memory-reflect': 'gpt-5.4',
  // M28 - the Rise assistant; quality tier, a real conversation same as
  // coaching-chat.
  'assistant-chat': 'gpt-5.4'
}

// Rough per-million-token pricing for usage/cost display. Update here only.
const PRICE_PER_MILLION_USD: Record<string, { input: number; output: number }> = {
  'gpt-5.4-mini': { input: 0.25, output: 2 },
  'gpt-5.4': { input: 2.5, output: 10 }
}

function usageFrom(model: string, inputTokens: number, outputTokens: number): AIUsage {
  const price = PRICE_PER_MILLION_USD[model] ?? { input: 0, output: 0 }
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000
  }
}

function toProviderError(err: unknown): AIProviderError {
  if (err instanceof OpenAI.AuthenticationError) {
    return new AIProviderError('auth', 'Your OpenAI API key was rejected.', undefined, 'structural')
  }
  if (err instanceof OpenAI.RateLimitError) {
    const msg = typeof err.message === 'string' ? err.message : ''
    return new AIProviderError(
      'rate-limit',
      'OpenAI is rate-limiting requests right now.',
      undefined,
      classifyFailureClass('rate-limit', { message: msg, status: err.status ?? undefined })
    )
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new AIProviderError('network', 'Could not reach OpenAI. Check your internet connection.')
  }
  if (err instanceof OpenAI.APIError) {
    const msg = typeof err.message === 'string' ? err.message.toLowerCase() : ''
    if (msg.includes('quota') || msg.includes('billing')) {
      return new AIProviderError(
        'failed',
        'Your OpenAI account is out of quota. Check billing at platform.openai.com.',
        undefined,
        'period-exhausted'
      )
    }
    return new AIProviderError(
      'failed',
      `OpenAI returned an error (${err.status ?? 'unknown'}).`,
      undefined,
      classifyFailureClass('failed', { message: msg, status: err.status ?? undefined })
    )
  }
  return new AIProviderError('failed', 'Something went wrong calling OpenAI. Please try again.')
}

function toMessages(req: AICompletionRequest): OpenAI.Chat.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  req.messages.forEach((m, i) => {
    if ((req.document || req.images?.length) && i === 0 && m.role === 'user') {
      const parts: OpenAI.Chat.ChatCompletionContentPart[] = []
      // M28 Part 3 — images as data-URL image parts, then any document, then text.
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
    throw new AIProviderError(
      'failed',
      'The model did not return the expected structured output.',
      undefined,
      classifyFailureClass('failed', { message: 'The model did not return the expected structured output.' })
    )
  }
  try {
    return JSON.parse(call.function.arguments) as Record<string, unknown>
  } catch {
    throw new AIProviderError(
      'failed',
      'The model returned malformed structured output.',
      undefined,
      classifyFailureClass('failed', { message: 'The model returned malformed structured output.' })
    )
  }
}

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai' as const
  readonly displayName = 'ChatGPT'
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async complete(req: AICompletionRequest): Promise<AICompletionResult> {
    const policy = LATENCY_POLICY[req.purpose]
    // M20: completeWithFallback() sets req.model explicitly when a catalog
    // entry is driving this call. Unset (every M16-era call site) falls back
    // to exactly today's per-purpose default - zero behavior change.
    const model = req.model ?? MODEL_BY_PURPOSE[req.purpose]
    try {
      const response = await this.client.chat.completions.create(
        {
          model,
          max_completion_tokens: req.maxTokens,
          temperature: req.temperature,
          messages: toMessages(req),
          tools: toTools(req),
          tool_choice: toToolChoice(req)
        },
        // BUG-058/BUG-059 — always the literal 0, never a variable. The SDK's own
        // internal retry sleep is an unabortable, uncapped setTimeout driven
        // by the provider's own Retry-After header — see openai-compatible.ts's
        // identical comment for the verified source. Our own walker owns every
        // retry decision now.
        { timeout: policy.timeoutMs, maxRetries: 0, signal: req.signal }
      )
      const message = response.choices[0]?.message
      const usage = usageFrom(
        model,
        response.usage?.prompt_tokens ?? 0,
        response.usage?.completion_tokens ?? 0
      )
      if (!message) throw new AIProviderError('failed', 'OpenAI returned no response.')
      if (req.tool) return { text: '', toolInput: parseToolInput(message), model, usage }
      return { text: message.content ?? '', model, usage }
    } catch (err) {
      if (err instanceof AIProviderError) throw err
      throw toProviderError(err)
    }
  }

  stream(req: AICompletionRequest): AIStreamResult {
    const policy = LATENCY_POLICY[req.purpose]
    const model = req.model ?? MODEL_BY_PURPOSE[req.purpose]
    const client = this.client

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
          // BUG-058/BUG-059 — always the literal 0, never a variable. The SDK's own
        // internal retry sleep is an unabortable, uncapped setTimeout driven
        // by the provider's own Retry-After header — see openai-compatible.ts's
        // identical comment for the verified source. Our own walker owns every
        // retry decision now.
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
        resolveUsage(usageFrom(model, inputTokens, outputTokens))
      } catch (err) {
        resolveUsage({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
        throw err instanceof AIProviderError ? err : toProviderError(err)
      }
    }

    const iterable = generator()
    return Object.assign(iterable, { usage })
  }

  async validateKey(key: string): Promise<AIValidateKeyResult> {
    try {
      const probe = new OpenAI({ apiKey: key })
      // Cheapest possible round-trip: a 1-token completion, no retries.
      await probe.chat.completions.create(
        {
          model: 'gpt-5.4-mini',
          max_completion_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }]
        },
        { timeout: 10_000, maxRetries: 0 }
      )
      return { ok: true, models: [...new Set(Object.values(MODEL_BY_PURPOSE))] }
    } catch (err) {
      const providerErr = toProviderError(err)
      return { ok: false, reason: providerErr.message }
    }
  }

  async listModels(): Promise<string[]> {
    return [...new Set(Object.values(MODEL_BY_PURPOSE))]
  }
}
