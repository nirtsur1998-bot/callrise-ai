// BUG-231 — the title must survive a model that will not call a tool.
//
// WHY THIS FILE EXISTS, and the number is measured rather than feared. Driving
// eight real calls on the founder's machine on 2026-09-08 produced three
// titles and five failures. The fallback log named every one, and seven of the
// underlying events were the same thing:
//
//     4x  "The model did not return the expected structured output."
//     3x  "Groq could not format a valid response ... (usually resolves on retry)"
//     1x  a model excluded outright by supportsToolCalling
//
// The title was the only feature in the app demanding a TOOL CALL to carry a
// five-word string, and tool calling is the least reliable capability on every
// free tier this app supports. So the fix is not a retry of the same shape —
// it is to stop requiring the hardest output format for the simplest possible
// payload.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const completeWithFallback = vi.fn()
vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback: (req: unknown) => completeWithFallback(req)
}))

const SEGMENTS = [
  { speaker: 0, text: 'Hi Ben, thanks for making time about the Acme renewal.' },
  { speaker: 1, text: 'Of course. We are looking at the enterprise tier.' }
] as never

beforeEach(() => {
  completeWithFallback.mockReset()
})

describe('titleFromText', () => {
  it('cleans the shapes a model actually returns in prose', async () => {
    const { titleFromText } = await import('../call-title')
    // Each of these is a real shape a model returns when asked for a title in
    // prose rather than through a tool.
    expect(titleFromText('Acme Co — Renewal Discussion')).toBe('Acme Co — Renewal Discussion')
    expect(titleFromText('"Acme Co — Renewal Discussion"')).toBe('Acme Co — Renewal Discussion')
    expect(titleFromText('Title: Acme Co — Renewal Discussion')).toBe('Acme Co — Renewal Discussion')
    expect(titleFromText('\n\n  Acme Co — Renewal  \n\nThis title reflects...')).toBe(
      'Acme Co — Renewal'
    )
    expect(titleFromText('Acme Co — Renewal Discussion.')).toBe('Acme Co — Renewal Discussion')
    expect(titleFromText('')).toBe('')
    expect(titleFromText('   \n  ')).toBe('')
  })

  it('bounds the length, so a model that ignores "5-8 words" cannot write a paragraph into the title', async () => {
    const { titleFromText } = await import('../call-title')
    expect(titleFromText('x'.repeat(500))).toHaveLength(100)
  })
})

describe('generateCallTitle survives a model that will not call a tool', () => {
  it('takes the prose answer when the tool call is missing but the text is right there', async () => {
    // The measured 4x case: no toolInput, and the answer sitting in `text`
    // being thrown away.
    completeWithFallback.mockResolvedValueOnce({
      text: 'Acme Co — Renewal Discussion',
      toolInput: undefined,
      model: 'llama-3.3-70b',
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    })
    const { generateCallTitle } = await import('../call-title')
    const res = await generateCallTitle(SEGMENTS)
    expect(res).toEqual({ ok: true, title: 'Acme Co — Renewal Discussion' })
    // One call, not two: the answer was already in hand.
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })

  it('retries WITHOUT the tool when the tool request throws, which is the Groq 400', async () => {
    // The measured 3x case: "400 Tool choice is required, but model did not
    // call a tool". Attempt two drops the tool, which also re-opens the models
    // the catalog excluded for not supporting one.
    completeWithFallback
      .mockRejectedValueOnce(
        new Error('400 Tool choice is required, but model did not call a tool')
      )
      .mockResolvedValueOnce({
        text: '"Ben — Quantum Platform Onboarding"',
        model: 'llama-3.3-70b',
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
      })
    const { generateCallTitle } = await import('../call-title')
    const res = await generateCallTitle(SEGMENTS)
    expect(res).toEqual({ ok: true, title: 'Ben — Quantum Platform Onboarding' })
    expect(completeWithFallback).toHaveBeenCalledTimes(2)
    // The whole point of attempt two: no tool, so a model that cannot call one
    // is still allowed to answer.
    expect(completeWithFallback.mock.calls[0][0]).toHaveProperty('tool')
    expect(completeWithFallback.mock.calls[1][0].tool).toBeUndefined()
  })

  it('prefers the structured answer when there is one', async () => {
    completeWithFallback.mockResolvedValueOnce({
      text: 'some chatter the model added',
      toolInput: { title: 'Carrie — SMSF Setup' },
      model: 'claude-sonnet-4-6',
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    })
    const { generateCallTitle } = await import('../call-title')
    expect(await generateCallTitle(SEGMENTS)).toEqual({ ok: true, title: 'Carrie — SMSF Setup' })
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })

  it('reports WHY it failed instead of a bare false — BUG-228', async () => {
    const { generateCallTitle } = await import('../call-title')

    // No transcript is a different situation from a refusal, and the caller
    // needs to be able to tell them apart. It used to be one `{ ok: false }`.
    expect(await generateCallTitle([] as never)).toEqual({ ok: false, reason: 'no-transcript' })
    expect(completeWithFallback).not.toHaveBeenCalled()

    completeWithFallback
      .mockRejectedValueOnce(new Error('tool refused'))
      .mockRejectedValueOnce(new Error('no prepaid credit left'))
    const res = await generateCallTitle(SEGMENTS)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('ai-failed')
      // The detail is the point: "no prepaid credit" sends someone to their
      // billing page, and a bare false sends them nowhere.
      expect(res.detail).toContain('no prepaid credit left')
    }
  })

  it('does not invent a title from an empty response', async () => {
    completeWithFallback
      .mockResolvedValueOnce({
        text: '',
        model: 'm',
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
      })
      .mockResolvedValueOnce({
        text: '   ',
        model: 'm',
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
      })
    const { generateCallTitle } = await import('../call-title')
    const res = await generateCallTitle(SEGMENTS)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('no-title-returned')
  })
})
