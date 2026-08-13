// BUG-060 (adapters 6-10/10) — the last five job types made cancellable.
// Same shape throughout: the fake AI call never settles on its own, only on
// abort, so an unwired path hangs the test instead of failing it.
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

const { mineObjections } = await import('../objection-mining')
const { assessDealRisk } = await import('../deal-risk')
const { generateTasks } = await import('../generate-tasks')

const SEGMENTS = [
  { speaker: 0, text: 'They pushed back hard on price in this call.', startMs: 0, endMs: 3000 }
]

describe('mineObjections() honours cancellation', () => {
  it('aborts the in-flight AI call when the signal fires', async () => {
    const controller = new AbortController()
    const promise = mineObjections(SEGMENTS, { signal: controller.signal })

    await vi.waitFor(() => expect(seen.length).toBe(1))
    expect(seen[0].signal).toBeDefined()

    controller.abort()

    const result = await promise
    expect(result.ok).toBe(false)
  })
})

describe('assessDealRisk() honours cancellation', () => {
  it('aborts the in-flight AI call when the signal fires', async () => {
    seen.length = 0
    const controller = new AbortController()
    const promise = assessDealRisk(
      {
        title: 'Acme deal',
        stageLabel: 'Discovery',
        value: 50_000,
        expectedCloseDate: '2026-09-01',
        createdAt: '2026-01-01T00:00:00.000Z',
        calls: []
      },
      { signal: controller.signal }
    )

    await vi.waitFor(() => expect(seen.length).toBe(1))
    controller.abort()

    const result = await promise
    expect(result.ok).toBe(false)
  })
})

describe('generateTasks() honours cancellation', () => {
  it('aborts the in-flight AI call when the signal fires', async () => {
    seen.length = 0
    const controller = new AbortController()
    const promise = generateTasks('a real call transcript worth generating tasks from', {
      signal: controller.signal
    })

    await vi.waitFor(() => expect(seen.length).toBe(1))
    controller.abort()

    const result = await promise
    expect(result.ok).toBe(false)
  })
})
