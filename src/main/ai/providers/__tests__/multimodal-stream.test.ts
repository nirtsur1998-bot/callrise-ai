// AUDIT FIX (2026-08-24) — images and PDFs must survive the STREAMING path,
// not just the complete() path.
//
// AnthropicProvider.stream() built its request as
// `req.messages.map((m) => ({ role: m.role, content: m.content }))`, skipping
// the private this.messages(req) that attaches image and document blocks.
// complete() called it; stream() did not. Rise streams — so every image and
// every PDF a user sent to Claude in Rise was silently discarded and the
// model answered about a file it had never seen. No error, no warning: the
// most confident possible wrong answer.
//
// The cause was mechanical. this.messages is a private METHOD, and the inner
// `async function* generator()` has its own `this`, so the builder was not
// reachable from where the request is assembled. Every sibling adapter uses a
// module-level toMessages/toContents and calls it correctly. Anthropic was
// the only one whose code shape made the right call impossible — which is
// exactly the kind of asymmetry a per-provider test would have caught and a
// shared one would not.
//
// There were no multimodal provider tests at all before this file.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ params: null as Record<string, unknown> | null }))

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        seen.params = params
        const iterable = {
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
          },
          finalMessage: async () => ({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 1, output_tokens: 1 }
          })
        }
        return iterable
      },
      create: async (params: Record<string, unknown>) => {
        seen.params = params
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 }
        }
      }
    }
    constructor(_opts: unknown) {}
  }
  return { default: FakeAnthropic }
})

const { AnthropicProvider } = await import('../anthropic')

const PNG_B64 = 'iVBORw0KGgo='
const PDF_B64 = 'JVBERi0xLjQK'

function baseReq(extra: Record<string, unknown>): never {
  return {
    purpose: 'assistant-chat',
    messages: [{ role: 'user', content: 'what is in this file?' }],
    maxTokens: 128,
    ...extra
  } as never
}

async function drain(result: AsyncIterable<{ delta: string }>): Promise<void> {
  for await (const _ of result) {
    // consume so the generator actually issues the request
  }
}

describe('AnthropicProvider.stream() — multimodal parts reach the wire', () => {
  beforeEach(() => {
    seen.params = null
  })

  it('an image survives streaming, as a native image block', async () => {
    const provider = new AnthropicProvider('test-key')
    await drain(
      provider.stream(baseReq({ images: [{ base64: PNG_B64, mimeType: 'image/png' }] }))
    )

    const messages = seen.params?.messages as { role: string; content: unknown }[]
    expect(messages, 'stream() issued no request at all').toBeTruthy()
    const content = messages[0].content
    expect(
      Array.isArray(content),
      'the first user message was sent as a bare string — the image was dropped, ' +
        'and Claude answered about a picture it never received'
    ).toBe(true)
    const blocks = content as { type: string; source?: { data?: string } }[]
    expect(blocks.some((b) => b.type === 'image' && b.source?.data === PNG_B64)).toBe(true)
    // The user's text must still be there alongside it.
    expect(blocks.some((b) => b.type === 'text')).toBe(true)
  })

  it('a PDF survives streaming, as a native document block', async () => {
    const provider = new AnthropicProvider('test-key')
    await drain(
      provider.stream(baseReq({ document: { base64: PDF_B64, filename: 'contract.pdf' } }))
    )

    const messages = seen.params?.messages as { role: string; content: unknown }[]
    const blocks = messages[0].content as { type: string; source?: { data?: string } }[]
    expect(
      Array.isArray(blocks),
      'the PDF was dropped on the streaming path — the model answered about a ' +
        'document it never received'
    ).toBe(true)
    expect(blocks.some((b) => b.type === 'document' && b.source?.data === PDF_B64)).toBe(true)
  })

  it('a plain text turn is unchanged — no over-wrapping when there is nothing to attach', async () => {
    const provider = new AnthropicProvider('test-key')
    await drain(provider.stream(baseReq({})))
    const messages = seen.params?.messages as { role: string; content: unknown }[]
    expect(messages[0].content).toBe('what is in this file?')
  })

  it('stream() and complete() agree — the two paths build the same parts', async () => {
    // The defect was precisely a DISAGREEMENT between these two: complete()
    // called the builder and stream() inlined a raw map. Asserting they match
    // is what stops the two drifting apart again, whichever one is edited.
    const provider = new AnthropicProvider('test-key')
    const req = baseReq({ images: [{ base64: PNG_B64, mimeType: 'image/png' }] })

    await drain(provider.stream(req))
    const streamed = JSON.stringify(seen.params?.messages)

    seen.params = null
    await provider.complete(req)
    const completed = JSON.stringify(seen.params?.messages)

    expect(streamed).toBe(completed)
  })
})
