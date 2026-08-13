// BUG-060 (adapter 2/10) — coachCall() must honour cancellation.
//
// Same shape as summarize-cancellation.test.ts: the fake AI call never
// settles on its own, only when its signal aborts. If coachCall() fails to
// thread the signal into completeWithFallback, this test HANGS rather than
// failing — it cannot accidentally pass.
import { describe, expect, it, vi } from 'vitest'

const seen: { signal?: AbortSignal }[] = []

vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback: (req: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      seen.push({ signal: req.signal })
      const s = req.signal
      if (!s) return // no signal threaded => hangs forever
      if (s.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      s.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }),
  AllModelsExhaustedError: class extends Error {}
}))

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('../app-settings', () => ({
  loadAppSettings: () => ({
    coach2: { enabled: false, methodology: 'blended' },
    personalization: { name: '', role: '', pronoun: '', about: '' }
  })
}))
vi.mock('../knowledge-fs', () => ({ listEntries: async () => [] }))
vi.mock('../knowledge-context', () => ({ assembleKnowledgeContext: () => '' }))
vi.mock('../memory/profile-injection', () => ({ repProfileSection: () => '' }))

const { coachCall } = await import('../coach')

const SEGMENTS = [{ speaker: 0, text: 'Let me walk you through pricing.', startMs: 0, endMs: 3000 }]

describe('coachCall() honours cancellation', () => {
  it('aborts the in-flight AI call when the signal fires', async () => {
    const controller = new AbortController()
    const promise = coachCall(SEGMENTS, 60_000, undefined, { signal: controller.signal })

    await vi.waitFor(() => expect(seen.length).toBe(1))
    expect(seen[0].signal).toBeDefined()

    controller.abort()

    const result = await promise
    expect(result.ok).toBe(false)
  })
})
