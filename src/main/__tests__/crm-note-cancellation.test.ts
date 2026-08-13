// BUG-060 (adapter 5/10) — generateCrmNote() and harvestKycFacts() must both
// honour cancellation. This job runs them IN PARALLEL (Promise.all in the
// executor), so both signals must be threaded — one unwired call would leave
// half the job un-cancellable. Same hang-on-unwired shape: neither fake AI
// call settles except on abort.
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
vi.mock('../memory/profile-injection', () => ({ businessProfileSection: () => '' }))

const { generateCrmNote } = await import('../crm-notes')
const { harvestKycFacts } = await import('../crm-note-generator')

const CONTACT = { id: 'c1', name: 'Dana', createdAt: '', updatedAt: '' } as never

describe('CRM note drafting honours cancellation', () => {
  it('generateCrmNote aborts the in-flight AI call', async () => {
    const controller = new AbortController()
    const promise = generateCrmNote('a real transcript worth drafting from', 'medium', {
      signal: controller.signal
    })

    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1))
    controller.abort()

    const result = await promise
    expect(result.ok).toBe(false)
  })

  it('harvestKycFacts aborts the in-flight AI call', async () => {
    seen.length = 0
    const controller = new AbortController()
    const promise = harvestKycFacts('a real transcript worth harvesting from', CONTACT, {
      signal: controller.signal
    })

    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1))
    controller.abort()

    // harvestKycFacts degrades to [] on any failure — returning proves the
    // call actually terminated rather than running to completion.
    const result = await promise
    expect(result).toEqual([])
  })

  it('BOTH calls abort off a single shared signal, as the job actually does it', async () => {
    seen.length = 0
    const controller = new AbortController()
    const both = Promise.all([
      generateCrmNote('transcript one', 'medium', { signal: controller.signal }),
      harvestKycFacts('transcript one', CONTACT, { signal: controller.signal })
    ])

    await vi.waitFor(() => expect(seen.length).toBe(2))
    expect(seen.every((s) => s.signal === controller.signal)).toBe(true)

    controller.abort()
    const [note, facts] = await both
    expect(note.ok).toBe(false)
    expect(facts).toEqual([])
  })
})
