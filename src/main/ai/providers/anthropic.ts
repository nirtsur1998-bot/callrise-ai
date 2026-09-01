import Anthropic from '@anthropic-ai/sdk'
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

// Same two tiers every call site already used before this migration —
// preserved exactly, just centralized. Haiku for latency-sensitive/cheap
// work, Sonnet for anything that can afford to think longer.
const MODEL_BY_PURPOSE: Record<AIPurpose, string> = {
  'coaching-cue': 'claude-haiku-4-5',
  summary: 'claude-sonnet-4-6',
  scorecard: 'claude-sonnet-4-6',
  tasks: 'claude-sonnet-4-6',
  other: 'claude-sonnet-4-6',
  // No consumer yet (M19 Task 3B not built) - same tier as 'other'.
  'prep-brief': 'claude-sonnet-4-6',
  // M24 - same fast/cheap tier as coaching-cue; same latency-critical shape.
  'deal-tier1': 'claude-haiku-4-5',
  // M24 - can afford to think longer; same tier as summary/scorecard.
  'deal-tier2': 'claude-sonnet-4-6',
  // M23 Workstream B - quality tier; a real coaching conversation.
  'coaching-chat': 'claude-sonnet-4-6',
  // M25 - fast/cheap tier, same as coaching-cue; a small fixed-shape pull.
  'memory-extract': 'claude-haiku-4-5',
  // M25 Phase 2 - judgment work, quality tier same as summary/scorecard.
  'memory-consolidate': 'claude-sonnet-4-6',
  'memory-reflect': 'claude-sonnet-4-6',
  // M28 - the Rise assistant; quality tier, a real conversation same as
  // coaching-chat.
  'assistant-chat': 'claude-sonnet-4-6'
}

// Rough per-million-token pricing for usage/cost display (Settings -> AI).
// Update here only — nothing else in the app hardcodes a price.
const PRICE_PER_MILLION_USD: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-4-6': { input: 3, output: 15 }
}

function usageFrom(model: string, inputTokens: number, outputTokens: number): AIUsage {
  const price = PRICE_PER_MILLION_USD[model] ?? { input: 0, output: 0 }
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000
  }
}

/** BUG-058 Phase 3 — Anthropic sends real ISO-8601 reset timestamps on every
 *  response (`anthropic-ratelimit-requests-reset` / `-tokens-reset`), not
 *  just 429s — confirmed against the SDK's own `RateLimitError.headers`
 *  (`core/error.d.ts`: a standard Fetch `Headers`, always populated on an
 *  APIError). Never parsed before this. Which resource actually caused the
 *  429 isn't told to us, so this takes the LATER of the two when both are
 *  present: an earlier timestamp could still be blocked if the OTHER
 *  resource is what was actually exhausted, and overstating the wait is a
 *  smaller error than promising a time that's still limited. */
function resetsAtFromHeaders(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined
  const candidates = ['anthropic-ratelimit-requests-reset', 'anthropic-ratelimit-tokens-reset']
    .map((name) => headers.get(name))
    .filter((v): v is string => v !== null)
    .map((v) => Date.parse(v))
    .filter((v) => Number.isFinite(v))
  return candidates.length > 0 ? Math.max(...candidates) : undefined
}

/** Exported for direct unit testing, same reasoning as
 *  openai-compatible.ts's own toProviderError export — asserting on error
 *  mapping (including BUG-058 Phase 3's resetsAt) shouldn't require
 *  standing up a real Anthropic client. */
export function toProviderError(err: unknown): AIProviderError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new AIProviderError('auth', 'Your Anthropic API key was rejected.', undefined, 'structural')
  }
  if (err instanceof Anthropic.RateLimitError) {
    const msg = typeof err.message === 'string' ? err.message : ''
    const failureClass = classifyFailureClass('rate-limit', { message: msg, status: err.status ?? undefined })
    return new AIProviderError(
      'rate-limit',
      'Anthropic is rate-limiting requests right now.',
      undefined,
      failureClass,
      // Messaging-only — only worth attaching when this IS the period-
      // exhausted case messageFor() actually branches on; an ordinary
      // per-minute throttle has no use for a reset timestamp.
      failureClass === 'period-exhausted' ? resetsAtFromHeaders(err.headers) : undefined
    )
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AIProviderError(
      'network',
      'Could not reach Anthropic. Check your internet connection.'
    )
  }
  if (err instanceof Anthropic.APIError) {
    const msg = typeof err.message === 'string' ? err.message.toLowerCase() : ''
    if (
      msg.includes('credit balance') ||
      msg.includes('plans & billing') ||
      msg.includes('billing')
    ) {
      return new AIProviderError(
        'failed',
        'Your Anthropic account is out of credits. Add credits at console.anthropic.com.',
        undefined,
        'period-exhausted'
      )
    }
    return new AIProviderError(
      'failed',
      `Anthropic returned an error (${err.status ?? 'unknown'}).`,
      undefined,
      classifyFailureClass('failed', { message: msg, status: err.status ?? undefined })
    )
  }
  return new AIProviderError('failed', 'Something went wrong calling Anthropic. Please try again.')
}

export class AnthropicProvider implements AIProvider {
  readonly id = 'anthropic' as const
  readonly displayName = 'Claude'
  private client: Anthropic

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey })
  }

  private toolChoice(req: AICompletionRequest): Anthropic.MessageCreateParams['tool_choice'] {
    return req.tool ? { type: 'tool', name: req.tool.name } : undefined
  }

  private messages(req: AICompletionRequest): Anthropic.MessageParam[] {
    const messages = req.messages.map(
      (m) => ({ role: m.role, content: m.content }) as Anthropic.MessageParam
    )
    if (req.document && messages.length > 0 && messages[0].role === 'user') {
      messages[0] = {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: req.document.base64 }
          },
          { type: 'text', text: req.messages[0].content }
        ]
      }
    }
    // M28 Part 3 — images ride on the first user message as native image
    // blocks, ahead of any document block and the text.
    if (req.images?.length && messages.length > 0 && messages[0].role === 'user') {
      const existing = messages[0].content
      const tail = Array.isArray(existing)
        ? existing
        : [{ type: 'text' as const, text: req.messages[0].content }]
      messages[0] = {
        role: 'user',
        content: [
          ...req.images.map((img) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mimeType as 'image/png',
              data: img.base64
            }
          })),
          ...tail
        ]
      } as Anthropic.MessageParam
    }
    return messages
  }

  private tools(req: AICompletionRequest): Anthropic.Tool[] | undefined {
    if (!req.tool) return undefined
    return [
      {
        name: req.tool.name,
        description: req.tool.description,
        input_schema: req.tool.inputSchema as Anthropic.Tool.InputSchema
      }
    ]
  }

  async complete(req: AICompletionRequest): Promise<AICompletionResult> {
    const policy = LATENCY_POLICY[req.purpose]
    // M20: completeWithFallback() sets req.model explicitly when a catalog
    // entry is driving this call. Unset (every M16-era call site) falls back
    // to exactly today's per-purpose default - zero behavior change.
    const model = req.model ?? MODEL_BY_PURPOSE[req.purpose]
    try {
      const response = await this.client.messages.create(
        {
          model,
          max_tokens: req.maxTokens,
          temperature: req.temperature,
          system: req.system,
          messages: this.messages(req),
          tools: this.tools(req),
          tool_choice: this.toolChoice(req)
        },
        // BUG-058/BUG-059 — always the literal 0, never a variable. Anthropic's own
        // sleep() DOES accept a signal (unlike OpenAI's), but the retry call
        // site never passes one through — verified in the vendored source — so
        // it is unabortable in practice either way, on a wait taken uncapped
        // from the provider's own header. Our own walker owns every retry
        // decision now.
        { timeout: policy.timeoutMs, maxRetries: 0, signal: req.signal }
      )
      const usage = usageFrom(model, response.usage.input_tokens, response.usage.output_tokens)
      if (req.tool) {
        const block = response.content.find((b) => b.type === 'tool_use')
        if (!block || block.type !== 'tool_use') {
          throw new AIProviderError(
            'failed',
            'The model did not return the expected structured output.',
            undefined,
            classifyFailureClass('failed', { message: 'The model did not return the expected structured output.' })
          )
        }
        return { text: '', toolInput: block.input as Record<string, unknown>, model, usage }
      }
      const textBlock = response.content.find((b) => b.type === 'text')
      return { text: textBlock?.type === 'text' ? textBlock.text : '', model, usage }
    } catch (err) {
      if (err instanceof AIProviderError) throw err
      throw toProviderError(err)
    }
  }

  stream(req: AICompletionRequest): AIStreamResult {
    const policy = LATENCY_POLICY[req.purpose]
    const model = req.model ?? MODEL_BY_PURPOSE[req.purpose]
    const client = this.client
    const tools = this.tools(req)
    const toolChoice = this.toolChoice(req)
    // AUDIT FIX (2026-08-24) — hoisted so the generator below can use it.
    //
    // stream() built its messages inline as
    // `req.messages.map((m) => ({ role: m.role, content: m.content }))`,
    // bypassing this.messages(req) — the method that attaches image and
    // document blocks. complete() called it; stream() did not. Rise streams,
    // so EVERY image and PDF a user sent to Claude in Rise was silently
    // dropped and the model answered about a file it had never seen. No
    // error, no warning: the most confident possible wrong answer.
    //
    // The cause is mechanical rather than careless: this.messages is a
    // private METHOD and the inner `async function* generator()` has its own
    // `this`, so the builder was simply not reachable from where the request
    // is assembled. Every sibling adapter builds its parts with a module-level
    // function (toMessages / toContents) and calls it correctly inside the
    // generator — Anthropic was the only one where the shape of the code made
    // the right call impossible. Hoisting to a const closes that.
    const messages = this.messages(req)

    let resolveUsage: (u: AIUsage) => void
    const usage = new Promise<AIUsage>((resolve) => {
      resolveUsage = resolve
    })

    async function* generator(): AsyncGenerator<{ delta: string }> {
      try {
        const stream = client.messages.stream(
          {
            model,
            max_tokens: req.maxTokens,
            temperature: req.temperature,
            system: req.system,
            messages,
            tools,
            tool_choice: toolChoice
          },
          // BUG-058/BUG-059 — always the literal 0, never a variable. Anthropic's own
        // sleep() DOES accept a signal (unlike OpenAI's), but the retry call
        // site never passes one through — verified in the vendored source — so
        // it is unabortable in practice either way, on a wait taken uncapped
        // from the provider's own header. Our own walker owns every retry
        // decision now.
        { timeout: policy.timeoutMs, maxRetries: 0, signal: req.signal }
        )
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { delta: event.delta.text }
          }
        }
        const final = await stream.finalMessage()
        resolveUsage(usageFrom(model, final.usage.input_tokens, final.usage.output_tokens))
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
      const probe = new Anthropic({ apiKey: key })
      // Cheapest possible round-trip: a 1-token completion, no retries.
      await probe.messages.create(
        { model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
        { timeout: 10_000, maxRetries: 0 }
      )
      return {
        ok: true,
        models: Object.values(MODEL_BY_PURPOSE).filter((v, i, a) => a.indexOf(v) === i)
      }
    } catch (err) {
      const providerErr = toProviderError(err)
      return { ok: false, reason: providerErr.message }
    }
  }

  async listModels(): Promise<string[]> {
    return [...new Set(Object.values(MODEL_BY_PURPOSE))]
  }
}
