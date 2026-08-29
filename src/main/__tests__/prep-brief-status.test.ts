// M31 Slice B — the calendar's prep-brief dot must never claim something
// untrue. The founder's framing: "a dot saying 'brief ready' when the brief
// is stale, or missing when one exists, is worse than no dot."
//
// The property under test is AGREEMENT, not plausibility. It would be easy
// to write a status function that returns sensible-looking values and still
// disagrees with what opening the brief actually does — file-exists is the
// obvious version of that bug, and it fails exactly when the rep updated the
// contact right before the meeting. So every test below pins
// getPrepBriefStatus() against ensurePrepBriefForEvent()'s OWN cache
// decision (`fromCache`) on the same fixture, rather than asserting the two
// separately and hoping they match.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  files: new Map<string, string>(),
  contact: { id: 'c1', name: 'Ben', updatedAt: 't1' } as { id: string; name: string; updatedAt: string },
  generateCalls: 0
}))

vi.mock('electron', () => ({ app: { getPath: () => 'C:/fake-userdata' } }))

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(async (path: string) => {
      const hit = store.files.get(path)
      if (hit === undefined) throw new Error('ENOENT')
      return hit
    }),
    mkdir: vi.fn(async () => undefined)
  }
}))

vi.mock('../atomic-write', () => ({
  writeJsonAtomic: vi.fn(async (path: string, data: unknown) => {
    store.files.set(path, JSON.stringify(data))
  })
}))

vi.mock('../contacts-fs', () => ({
  getContact: vi.fn(async (_dir: string, id: string) => (id === store.contact.id ? store.contact : null)),
  findContactByEmail: vi.fn(async () => null)
}))
vi.mock('../deals-fs', () => ({ listDeals: vi.fn(async () => []), getDeal: vi.fn(async () => null) }))
vi.mock('../calls-fs', () => ({ listCalls: vi.fn(async () => []), getCall: vi.fn(async () => null) }))
vi.mock('../deal-stages', () => ({ loadDealStages: vi.fn(() => []) }))
vi.mock('../personalization-context', () => ({ assemblePersonalizationContext: vi.fn(() => '') }))
vi.mock('../app-settings', () => ({ loadAppSettings: vi.fn(() => ({ personalization: null })) }))

vi.mock('../prep-brief', () => ({
  generatePrepBrief: vi.fn(async () => {
    store.generateCalls += 1
    return {
      ok: true as const,
      brief: {
        whoYoureMeeting: 'Ben',
        dealStatus: '',
        lastTime: '',
        openCommitments: [],
        likelyObjections: [],
        openers: [],
        generatedAt: '2026-08-29T00:00:00.000Z'
      }
    }
  })
}))

const { getPrepBriefStatus, ensurePrepBriefForEvent } = await import('../prep-brief-fs')

const INPUT = {
  eventId: 'evt-1',
  title: 'Renewal call',
  startIso: '2026-09-01T11:00:00.000Z',
  attendees: [],
  contactId: 'c1'
}

beforeEach(() => {
  store.files.clear()
  store.contact = { id: 'c1', name: 'Ben', updatedAt: 't1' }
  store.generateCalls = 0
})

describe('getPrepBriefStatus', () => {
  it("reports 'none' when no brief has ever been generated", async () => {
    expect(await getPrepBriefStatus(INPUT)).toBe('none')
  })

  it("reports 'ready' only when opening the brief would genuinely serve the cache", async () => {
    await ensurePrepBriefForEvent(INPUT)
    expect(store.generateCalls).toBe(1)

    expect(await getPrepBriefStatus(INPUT)).toBe('ready')

    // The agreement check: the dot said 'ready', so opening it must cost no
    // AI call and must come back fromCache.
    const reopened = await ensurePrepBriefForEvent(INPUT)
    expect(reopened.ok && reopened.fromCache).toBe(true)
    expect(store.generateCalls).toBe(1)
  })

  it("reports 'outdated' — NOT 'ready' — once the contact changes underneath it", async () => {
    await ensurePrepBriefForEvent(INPUT)
    expect(await getPrepBriefStatus(INPUT)).toBe('ready')

    // The rep edits the contact before the meeting. This is the exact case a
    // file-exists check gets wrong, and the one where being wrong hurts most.
    store.contact = { id: 'c1', name: 'Ben', updatedAt: 't2' }

    expect(await getPrepBriefStatus(INPUT)).toBe('outdated')

    // Agreement again, in the other direction: the dot said 'outdated', so
    // opening it must actually regenerate rather than serve the stale copy.
    const reopened = await ensurePrepBriefForEvent(INPUT)
    expect(reopened.ok && reopened.fromCache).toBe(false)
    expect(store.generateCalls).toBe(2)
  })

  it("returns to 'ready' after the regenerate the 'outdated' state predicted", async () => {
    await ensurePrepBriefForEvent(INPUT)
    store.contact = { id: 'c1', name: 'Ben', updatedAt: 't2' }
    expect(await getPrepBriefStatus(INPUT)).toBe('outdated')
    await ensurePrepBriefForEvent(INPUT)
    expect(await getPrepBriefStatus(INPUT)).toBe('ready')
  })

  it("never reports 'ready' for an event whose brief belongs to a DIFFERENT meeting", async () => {
    await ensurePrepBriefForEvent(INPUT)
    expect(await getPrepBriefStatus({ ...INPUT, eventId: 'evt-2' })).toBe('none')
  })

  it("treats a meeting-detail change (a moved start time) as outdated, matching the cache key", async () => {
    await ensurePrepBriefForEvent(INPUT)
    const moved = { ...INPUT, startIso: '2026-09-01T15:00:00.000Z' }
    expect(await getPrepBriefStatus(moved)).toBe('outdated')
    const reopened = await ensurePrepBriefForEvent(moved)
    expect(reopened.ok && reopened.fromCache).toBe(false)
  })
})
