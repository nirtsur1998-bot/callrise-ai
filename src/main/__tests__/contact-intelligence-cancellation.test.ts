// BUG-060 (adapter 4/10) — detectOtherPartyName() must honour cancellation.
//
// Tested at this layer (not through the executor / detectAndSaveIdentity)
// because that's where the actual completeWithFallback call lives — the
// layers above it are a straight pass-through of `opts.signal`, verified by
// typecheck and code inspection. Same hang-on-unwired shape as every other
// adapter: the fake AI call only settles on abort.
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

const { detectOtherPartyName } = await import('../contact-intelligence')

const SEGMENTS = [
  { speaker: 0, text: "Hi, I'm calling from Acme about your account.", startMs: 0, endMs: 3000 },
  { speaker: 1, text: "Sure, what's this regarding?", startMs: 3000, endMs: 5000 }
]

describe('detectOtherPartyName() honours cancellation', () => {
  it('aborts the in-flight AI call when the signal fires', async () => {
    const controller = new AbortController()
    const promise = detectOtherPartyName(SEGMENTS, 1, 0, false, { signal: controller.signal })

    await vi.waitFor(() => expect(seen.length).toBe(1))
    expect(seen[0].signal).toBeDefined()

    controller.abort()

    // detectOtherPartyName degrades to null on any AI failure — what matters
    // is that it RETURNS, i.e. the call actually terminated.
    const result = await promise
    expect(result).toBeNull()
  })
})
