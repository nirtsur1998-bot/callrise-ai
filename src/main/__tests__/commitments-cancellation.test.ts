// BUG-060 (adapter 3/10) — extractCommitments() must honour cancellation.
// Same shape as the prior adapters: the fake AI call only settles on abort,
// so a missing signal hangs the test instead of failing it.
import { describe, expect, it, vi } from 'vitest'

const seen: { signal?: AbortSignal }[] = []

vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback: (req: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      seen.push({ signal: req.signal })
      const s = req.signal
      if (!s) return
      if (s.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      s.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }),
  AllModelsExhaustedError: class extends Error {}
}))

const { extractCommitments } = await import('../commitments')

// 25+ words, or extractCommitments short-circuits before ever calling the AI.
const SEGMENTS = [
  {
    speaker: 0,
    text: 'I will send over the proposal by Friday and follow up with the contract next week once legal has reviewed the terms and everyone is aligned on pricing.',
    startMs: 0,
    endMs: 8000
  }
]

describe('extractCommitments() honours cancellation', () => {
  it('aborts the in-flight AI call when the signal fires', async () => {
    const controller = new AbortController()
    const promise = extractCommitments(SEGMENTS, { signal: controller.signal })

    await vi.waitFor(() => expect(seen.length).toBe(1))
    expect(seen[0].signal).toBeDefined()

    controller.abort()

    const result = await promise
    expect(result.ok).toBe(false)
  })
})
