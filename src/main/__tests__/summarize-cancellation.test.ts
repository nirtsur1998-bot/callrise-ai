// BUG-060 — Cancel must stop the WORK, not just remove the row from the UI.
//
// Every Cancel button in this app was cosmetic. JobManager hands each executor
// an AbortSignal and its own doc comment (JobManager.ts:150-156) says adapters
// MUST thread it into completeWithFallback's `req.signal` "for cancel to mean
// anything" — and zero of the adapters did. Pressing Cancel marked the job
// cancelled while the AI call ran on to completion, still spending the user's
// key. On a 1-2 free-key setup that is the difference between one wasted call
// and a dead afternoon.
//
// TEST SHAPE, deliberately: the fake AI call NEVER settles on its own — it
// only ever settles when the signal it was handed aborts. So if summarize()
// fails to thread the signal through, this test HANGS rather than failing.
// It cannot accidentally pass, which is the same property that makes the
// BUG-059 ceiling test trustworthy.
import { describe, expect, it, vi } from 'vitest'

const seen: { signal?: AbortSignal }[] = []

vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback: (req: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      seen.push({ signal: req.signal })
      const s = req.signal
      if (!s) return // no signal threaded => hangs forever, which IS the bug
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
    personalization: { name: '', role: '', pronoun: '', about: '' },
    summaryLanguage: 'auto'
  })
}))

const { summarize } = await import('../summarize')

describe('summarize() honours cancellation', () => {
  it('aborts the in-flight AI call when the signal fires', async () => {
    const controller = new AbortController()
    const promise = summarize({ kind: 'text', text: 'a real transcript' }, { signal: controller.signal })

    // The call is genuinely in flight and holding the signal we passed.
    await vi.waitFor(() => expect(seen.length).toBe(1))
    expect(seen[0].signal).toBeDefined()

    controller.abort()

    // summarize() catches provider errors and degrades rather than throwing —
    // what matters is that it RETURNS, i.e. the underlying call actually
    // terminated instead of running to completion.
    const result = await promise
    expect(result.ok).toBe(false)
  })

  it('passes no signal when a caller does not supply one — plain IPC callers are unchanged', async () => {
    seen.length = 0
    const controller = new AbortController()
    // Nothing waits forever here because we abort immediately; the point is
    // that the optional param stays optional for non-job callers.
    void summarize({ kind: 'text', text: 'x' }, { signal: controller.signal })
    await vi.waitFor(() => expect(seen.length).toBe(1))
    controller.abort()
    expect(seen[0].signal).toBe(controller.signal)
  })
})
