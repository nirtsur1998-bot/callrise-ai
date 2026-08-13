// BUG-060 (adapters 9-10/10, plumbing half).
//
// maybeGenerateCrmNote() and runFullAutoContactIntelligence() don't make an
// AI call themselves; they forward to generateCrmNote() and
// detectAndSaveIdentity(), whose own cancellation is already proven end to
// end elsewhere (crm-note-cancellation.test.ts,
// contact-intelligence-cancellation.test.ts). What's new here is only the
// one-line pass-through parameter — this test proves the signal actually
// reaches the real detectOtherPartyName/completeWithFallback call through
// the FULL real chain (nothing mocked but completeWithFallback itself and
// the fs/settings layer), same hang-on-unwired shape as every other adapter.
//
// maybeGenerateCrmNote is NOT exported from calls.ts (private to that
// module), and this fix doesn't export it just to make it testable in
// isolation — that would be a real API-surface change for a test's
// convenience, not something the fix needs. Its own one-line change
// (`generateCrmNote(content, undefined, { signal: opts?.signal })`) is
// verified by direct code review and by the typecheck already passing;
// stated here rather than left silently unproven.
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

vi.mock('electron', () => ({ app: { getPath: () => process.cwd() } }))
vi.mock('../app-settings', () => ({
  getContactIntelligenceMode: () => 'full-auto',
  isSelfIntroExtractionAllowed: () => true
}))
vi.mock('../calls-fs', async (importOriginal) => {
  // speakerIdentityKey is real (a pure one-liner) — otherPartyKey() imports
  // it from this same module, and mocking it out entirely made every
  // candidate look identical to "me", silently short-circuiting before the
  // AI call this test needs to observe.
  const actual = await importOriginal<typeof import('../calls-fs')>()
  return {
    ...actual,
    getCall: async () => ({
      id: 'call-1',
      segments: [
        { speaker: 0, text: "Hi, it's Alex calling about your renewal.", kind: 'speech' },
        { speaker: 1, text: 'Sure, go ahead.', kind: 'speech' }
      ],
      speakerIdentities: {},
      consent: { recordOtherParty: true },
      // repSpeaker must resolve to a real number, not null, or otherPartyKey()
      // bails out before ever reaching the AI call this test needs to observe.
      coaching: { metrics: { repSpeaker: 0 } }
    }),
    setSpeakerIdentity: async () => true,
    speechSegments: (segs: unknown[]) => segs
  }
})

describe('runFullAutoContactIntelligence threads its signal all the way to the real AI call', () => {
  it('aborts the in-flight detection call when the signal fires', async () => {
    const { runFullAutoContactIntelligence } = await import('../contact-intelligence-ipc')
    const controller = new AbortController()

    // Fire-and-forget internally catches its own errors, so this always
    // resolves — what matters is that the real chain was actually entered.
    const promise = runFullAutoContactIntelligence('call-1', { signal: controller.signal })

    await vi.waitFor(() => expect(seen.length).toBe(1))
    expect(seen[0].signal).toBe(controller.signal)

    controller.abort()
    await expect(promise).resolves.toBeUndefined()
  })
})
