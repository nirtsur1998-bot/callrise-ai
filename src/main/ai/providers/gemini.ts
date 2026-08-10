// M20: Google AI Studio (Gemini) adapter. Not OpenAI-compatible - Gemini's
// REST wire format is its own shape, so this is a bespoke fetch-based
// adapter rather than an openai-compatible.ts instance. No @google/genai
// dependency added: the request/response shape is small enough that a
// direct fetch avoids pulling in a whole SDK for one provider.
//
// Forced single-tool-call equivalent of Anthropic's tool_choice/OpenAI's
// tool_choice: `toolConfig.functionCallingConfig` with mode 'ANY' +
// allowedFunctionNames - confirmed against ai.google.dev/api/generate-content.
// Field names are camelCase on the wire (toolConfig, functionCallingConfig,
// allowedFunctionNames, inlineData, mimeType) - this is the REST/JSON
// convention, not the snake_case used by Google's Python client libraries.
import {
  AIProviderError,
  LATENCY_POLICY,
  type AICompletionRequest,
  type AICompletionResult,
  type AIProvider,
  type AIStreamResult,
  type AIUsage,
  type AIValidateKeyResult
} from '../types'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// Cheapest/fastest model for the "Test key" round trip and the M16-parity
// default when a caller never sets req.model. resolveCatalog() (model-
// catalog.ts) resolves the REAL "latest Flash" id from listModels() at
// runtime for the catalog entry - this is only the validate-key/default
// fallback, never the catalog's source of truth for the Gemini Flash entry.
const DEFAULT_MODEL = 'gemini-flash-latest'

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, unknown> }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

// Gemini's function-declaration Schema is a RESTRICTED subset of OpenAPI's
// Schema object (Google's own docs: "only a subset of the OpenAPI schema is
// supported") - confirmed fields are type/properties/items/required/
// description/enum; `additionalProperties` and `$schema` are not among them.
// Every AITool in this codebase (COACH_TOOL, SUMMARY_TOOL, TASKS_TOOL, the
// live_cue tool, etc.) sets `additionalProperties: false` per plain JSON
// Schema convention, which Anthropic/OpenAI both accept natively - Gemini's
// REST API rejects the whole request with a 400 the moment it sees a field
// it doesn't recognize, so every tool-calling request to Gemini failed
// outright (root-caused 2026-08-03 from a real user's "chain exhausted"
// reports - every attempt failed with the generic 'failed' code, consistent
// with a structural 400 on every single request, not an auth/quota issue).
//
// M22 bug hunt found a second, narrower instance of the same class of bug:
// live-cue.ts's optional buyerName/buyerSpeaker fields use JSON Schema
// 2020-12's `type: ['string', 'null']` nullable convention (which Anthropic/
// OpenAI both also accept natively) - Gemini's restricted Schema object does
// not support `type` as an array at all, only a single type value plus a
// separate `nullable: true` flag (OpenAPI 3.0's convention). Sent as-is, this
// 400s the request the moment self-intro extraction is on and a live-cue job
// is assigned to a Gemini model - unreachable through the default SPEED_CHAIN
// (Gemini isn't in it), but reachable the instant a user assigns Gemini as
// coaching-cue's primary model in Settings, same as the schema bug above.
//
// Recurses into properties/items since a deeper tool could nest either
// keyword in a sub-schema.
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-to-omit is the standard way to strip named keys from an object
  const { additionalProperties: _additionalProperties, $schema: _$schema, ...rest } = schema
  if (Array.isArray(rest.type)) {
    const types = rest.type as unknown[]
    const nullable = types.includes('null')
    const real = types.find((t) => t !== 'null')
    if (real !== undefined) rest.type = real
    else delete rest.type
    if (nullable) rest.nullable = true
  }
  if (rest.properties && typeof rest.properties === 'object') {
    rest.properties = Object.fromEntries(
      Object.entries(rest.properties as Record<string, unknown>).map(([key, value]) => [
        key,
        value && typeof value === 'object' ? toGeminiSchema(value as Record<string, unknown>) : value
      ])
    )
  }
  if (rest.items && typeof rest.items === 'object') {
    rest.items = toGeminiSchema(rest.items as Record<string, unknown>)
  }
  return rest
}

function toContents(req: AICompletionRequest): GeminiContent[] {
  return req.messages.map((m, i) => {
    const parts: GeminiPart[] = []
    if (req.document && i === 0 && m.role === 'user') {
      parts.push({
        inlineData: { mimeType: 'application/pdf', data: req.document.base64 }
      })
    }
    parts.push({ text: m.content })
    return { role: m.role === 'assistant' ? 'model' : 'user', parts }
  })
}

function combineSignals(a?: AbortSignal, timeoutMs?: number): AbortSignal {
  const signals: AbortSignal[] = []
  if (a) signals.push(a)
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs))
  if (signals.length === 0) return new AbortController().signal
  if (signals.length === 1) return signals[0]
  return AbortSignal.any(signals)
}

async function toProviderError(displayName: string, res: Response): Promise<AIProviderError> {
  let message = `${displayName} returned an error (${res.status}).`
  let googleStatus = ''
  try {
    const body = (await res.json()) as { error?: { message?: string; status?: string } }
    if (body.error?.message) message = body.error.message
    if (body.error?.status) googleStatus = body.error.status
  } catch {
    /* non-JSON error body - keep the generic status-code message */
  }
  if (res.status === 401 || res.status === 403 || googleStatus === 'PERMISSION_DENIED') {
    return new AIProviderError('auth', `Your ${displayName} API key was rejected.`)
  }
  if (res.status === 429 || googleStatus === 'RESOURCE_EXHAUSTED') {
    return new AIProviderError('rate-limit', `${displayName} is rate-limiting requests right now.`)
  }
  if (res.status === 404 || googleStatus === 'NOT_FOUND') {
    return new AIProviderError('model-not-found', `${displayName} does not recognize this model.`)
  }
  if (res.status >= 500) {
    return new AIProviderError('failed', `${displayName} returned a server error (${res.status}).`)
  }
  return new AIProviderError('failed', message)
}

export class GeminiProvider implements AIProvider {
  readonly id = 'google' as const
  readonly displayName = 'Gemini'
  private apiKey: string

  constructor(apiKey: string) {
    this.apiKey = apiKey
  }

  private async generateContent(
    req: AICompletionRequest,
    model: string
  ): Promise<{ text: string; toolInput?: Record<string, unknown>; usage: AIUsage }> {
    const policy = LATENCY_POLICY[req.purpose]
    const body: Record<string, unknown> = {
      contents: toContents(req),
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {})
      }
    }
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }
    if (req.tool) {
      body.tools = [
        {
          functionDeclarations: [
            {
              name: req.tool.name,
              description: req.tool.description,
              parameters: toGeminiSchema(req.tool.inputSchema)
            }
          ]
        }
      ]
      body.toolConfig = {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [req.tool.name] }
      }
    }

    let res: Response
    try {
      res = await fetch(`${API_BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: combineSignals(req.signal, policy.timeoutMs)
      })
    } catch (err) {
      // 'AbortError' fires when completeWithFallback()'s per-attempt budget
      // timeout aborts the combined signal (see combineSignals above) -
      // never a user-initiated cancel in this codebase, so 'timeout' is
      // accurate for both this and the native fetch-level 'TimeoutError'.
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AIProviderError('timeout', `${this.displayName} did not respond in time.`)
      }
      throw new AIProviderError(
        'network',
        `Could not reach ${this.displayName}. Check your internet connection.`
      )
    }

    if (!res.ok) throw await toProviderError(this.displayName, res)

    const data = (await res.json()) as {
      candidates?: { content?: { parts?: GeminiPart[] } }[]
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
    }
    const parts = data.candidates?.[0]?.content?.parts ?? []
    const usage: AIUsage = {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      // Free-tier catalog entry (see ai/model-catalog.ts) - no invented price.
      estimatedCostUsd: 0
    }

    if (req.tool) {
      const call = parts.find((p) => p.functionCall)?.functionCall
      if (!call) {
        throw new AIProviderError(
          'failed',
          'The model did not return the expected structured output.'
        )
      }
      return { text: '', toolInput: call.args, usage }
    }
    const text = parts
      .map((p) => p.text ?? '')
      .join('')
      .trim()
    return { text, usage }
  }

  async complete(req: AICompletionRequest): Promise<AICompletionResult> {
    const model = req.model ?? DEFAULT_MODEL
    const result = await this.generateContent(req, model)
    return { ...result, model }
  }

  // Gemini supports streamGenerateContent?alt=sse, but every real call site
  // in this codebase does a single forced tool-call (see types.ts's top
  // comment) - implemented for interface completeness/future use, same
  // caveat as the other two providers, not exercised by any current caller.
  stream(req: AICompletionRequest): AIStreamResult {
    const model = req.model ?? DEFAULT_MODEL
    const apiKey = this.apiKey
    const displayName = this.displayName
    const policy = LATENCY_POLICY[req.purpose]

    let resolveUsage: (u: AIUsage) => void
    const usage = new Promise<AIUsage>((resolve) => {
      resolveUsage = resolve
    })

    async function* generator(): AsyncGenerator<{ delta: string }> {
      try {
        const body: Record<string, unknown> = {
          contents: toContents(req),
          generationConfig: { maxOutputTokens: req.maxTokens, temperature: req.temperature }
        }
        if (req.system) body.systemInstruction = { parts: [{ text: req.system }] }

        const res = await fetch(`${API_BASE}/models/${model}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: combineSignals(req.signal, policy.timeoutMs)
        })
        if (!res.ok || !res.body) throw await toProviderError(displayName, res)

        let inputTokens = 0
        let outputTokens = 0
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const parsed = JSON.parse(line.slice(6)) as {
              candidates?: { content?: { parts?: GeminiPart[] } }[]
              usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
            }
            const text = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
            if (text) yield { delta: text }
            if (parsed.usageMetadata) {
              inputTokens = parsed.usageMetadata.promptTokenCount ?? inputTokens
              outputTokens = parsed.usageMetadata.candidatesTokenCount ?? outputTokens
            }
          }
        }
        resolveUsage({ inputTokens, outputTokens, estimatedCostUsd: 0 })
      } catch (err) {
        resolveUsage({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
        throw err instanceof AIProviderError ? err : new AIProviderError('failed', String(err))
      }
    }

    const iterable = generator()
    return Object.assign(iterable, { usage })
  }

  async validateKey(key: string): Promise<AIValidateKeyResult> {
    try {
      const probe = new GeminiProvider(key)
      await probe.generateContent(
        {
          messages: [{ role: 'user', content: 'hi' }],
          maxTokens: 1,
          purpose: 'other'
        },
        DEFAULT_MODEL
      )
      return { ok: true, models: await this.listModels() }
    } catch (err) {
      const providerErr = err instanceof AIProviderError ? err : new AIProviderError('failed', String(err))
      return { ok: false, reason: providerErr.message }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${API_BASE}/models`, {
        headers: { 'x-goog-api-key': this.apiKey },
        signal: AbortSignal.timeout(10_000)
      })
      if (!res.ok) return [DEFAULT_MODEL]
      const data = (await res.json()) as { models?: { name: string }[] }
      // Wire format is "models/gemini-2.5-flash" - strip the prefix so
      // catalog modelIds are the plain id used in generateContent's URL.
      return (data.models ?? []).map((m) => m.name.replace(/^models\//, ''))
    } catch {
      return [DEFAULT_MODEL]
    }
  }
}

export function createGeminiProvider(apiKey: string): AIProvider {
  return new GeminiProvider(apiKey)
}
