// BUG-234 — the app asks for a schema as a TOOL CALL where structured output
// is the guaranteed path, and that is a category error rather than a
// reliability problem.
//
// THE ROOT CAUSE, in one line of types.ts: `tool?: AITool` is SINGULAR, and
// every adapter pins tool_choice to that one name. The app has never offered a
// model a CHOICE of tools — not once, across 27 tool definitions and 28 call
// sites. It has been spelling structured output through the API surface every
// provider guarantees least.
//
// MEASURED CONSEQUENCE, 2026-09-08: eight real calls titled three. Seven of
// the underlying failures were a model declining or failing to emit a tool
// call ("The model did not return the expected structured output" x4, "Groq
// could not format a valid response ... 400 Tool choice is required, but model
// did not call a tool" x3).
//
// This file covers the Anthropic half — the provider the founder is buying a
// key for. Verified against the INSTALLED SDK rather than a docs page:
// output_config.format is on the non-beta MessageCreateParams in
// @anthropic-ai/sdk 0.107.0, and the response carries parsed_output.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const create = vi.fn()
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create }
    constructor(_opts: unknown) {}
  }
  // The error classes toProviderError instanceof-checks. Real enough to
  // construct; none of these tests take an error path.
  const asError = (): unknown => class extends Error {}
  return {
    default: Object.assign(FakeAnthropic, {
      AuthenticationError: asError(),
      RateLimitError: asError(),
      APIConnectionError: asError(),
      APIError: asError()
    })
  }
})

const TOOL = {
  name: 'record_title',
  description: 'Record a title.',
  inputSchema: {
    type: 'object' as const,
    properties: { title: { type: 'string' } },
    required: ['title'],
    additionalProperties: false
  }
}

const baseReq = {
  purpose: 'other' as const,
  maxTokens: 60,
  messages: [{ role: 'user' as const, content: 'hi' }],
  tool: TOOL
}

const reply = (over: Record<string, unknown>): Record<string, unknown> => ({
  content: [],
  usage: { input_tokens: 10, output_tokens: 5 },
  ...over
})

beforeEach(() => {
  create.mockReset()
})

async function provider(): Promise<{ complete: (r: unknown) => Promise<unknown> }> {
  const { AnthropicProvider } = await import('../anthropic')
  return new AnthropicProvider('sk-test') as unknown as {
    complete: (r: unknown) => Promise<unknown>
  }
}

describe('supportsStructuredOutput — a list whose rot points the safe way', () => {
  it('recognises the models that take an output format', async () => {
    const { supportsStructuredOutput } = await import('../anthropic')
    expect(supportsStructuredOutput('claude-haiku-4-5')).toBe(true)
    expect(supportsStructuredOutput('claude-haiku-4-5-20251001')).toBe(true)
    expect(supportsStructuredOutput('claude-sonnet-5')).toBe(true)
  })

  it('says NO for anything it has not been told about, including unset', async () => {
    // The direction of the rot IS the design. A model missing from the list
    // keeps the forced-tool path — today's behaviour — so a stale list costs
    // reliability the app already lacks and can never send a schema to a model
    // that cannot honour it.
    const { supportsStructuredOutput } = await import('../anthropic')
    expect(supportsStructuredOutput('claude-sonnet-4-6')).toBe(false)
    expect(supportsStructuredOutput('some-future-model')).toBe(false)
    expect(supportsStructuredOutput(undefined)).toBe(false)
  })
})

describe('Anthropic: a schema goes as an output FORMAT, not as a forced tool', () => {
  it('sends output_config and NO tool when the model supports it', async () => {
    create.mockResolvedValue(reply({ parsed_output: { title: 'Acme — Renewal' } }))
    const p = await provider()
    const res = await p.complete({ ...baseReq, model: 'claude-haiku-4-5' })

    const body = create.mock.calls[0][0]
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: TOOL.inputSchema }
    })
    // Both must be absent: asking for a tool AND a format at once is asking
    // the model two different questions.
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()

    // The RESULT SHAPE is unchanged, which is the reason none of the 28 call
    // sites had to move: they keep reading `toolInput`.
    expect(res).toMatchObject({ toolInput: { title: 'Acme — Renewal' }, text: '' })
  })

  it('keeps the forced-tool path for a model not on the list', async () => {
    create.mockResolvedValue(
      reply({ content: [{ type: 'tool_use', input: { title: 'From a tool' } }] })
    )
    const p = await provider()
    const res = await p.complete({ ...baseReq, model: 'claude-sonnet-4-6' })

    const body = create.mock.calls[0][0]
    expect(body.output_config).toBeUndefined()
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_title' })
    expect(body.tools).toHaveLength(1)
    expect(res).toMatchObject({ toolInput: { title: 'From a tool' } })
  })

  it('a request with no tool asks for neither, on either kind of model', async () => {
    create.mockResolvedValue(reply({ content: [{ type: 'text', text: 'plain answer' }] }))
    const p = await provider()
    await p.complete({
      purpose: 'other',
      maxTokens: 60,
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-haiku-4-5'
    })
    const body = create.mock.calls[0][0]
    expect(body.output_config).toBeUndefined()
    expect(body.tools).toBeUndefined()
    expect(body.tool_choice).toBeUndefined()
  })

  it('still accepts a tool_use block on a structured-output model, rather than insisting', async () => {
    // Belt and braces: if the API ever answers the old way on a model this
    // list calls new, the answer is still taken. Refusing it would turn a
    // successful call into a failure over which field it arrived in.
    create.mockResolvedValue(
      reply({ content: [{ type: 'tool_use', input: { title: 'Old shape' } }] })
    )
    const p = await provider()
    const res = await p.complete({ ...baseReq, model: 'claude-haiku-4-5' })
    expect(res).toMatchObject({ toolInput: { title: 'Old shape' } })
  })

  it('fails the way it always did when neither arrives', async () => {
    create.mockResolvedValue(reply({ content: [{ type: 'text', text: 'I refuse' }] }))
    const p = await provider()
    await expect(p.complete({ ...baseReq, model: 'claude-haiku-4-5' })).rejects.toThrow(
      /did not return the expected structured output/
    )
  })
})
