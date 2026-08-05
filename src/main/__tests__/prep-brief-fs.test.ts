// M23 bug hunt: two real gaps found in prep-brief context assembly.
//
// 1. Contact matching was only ever attempted when a meeting had EXACTLY one
//    attendee — any group meeting (a demo with two people from the buyer's
//    side, a call with the buyer plus a colleague) silently skipped matching
//    entirely, producing a near-empty brief with no indication matching was
//    even attempted.
// 2. computeInputHash never included personalization settings, so editing
//    personalization (tone/style) after a brief was cached had no effect on
//    that meeting's brief until a manual "Regenerate".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const contacts = vi.hoisted(() => ({
  byId: new Map<string, { id: string; updatedAt: string; email?: string }>(),
  byEmail: new Map<string, { id: string; updatedAt: string; email?: string }>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/fake-userdata' }
}))
vi.mock('../contacts-fs', () => ({
  getContact: vi.fn(async (_dir: string, id: string) => contacts.byId.get(id) ?? null),
  findContactByEmail: vi.fn(async (_dir: string, email: string) => contacts.byEmail.get(email) ?? null)
}))
vi.mock('../deals-fs', () => ({
  listDeals: vi.fn(async () => []),
  getDeal: vi.fn(async () => null)
}))
vi.mock('../calls-fs', () => ({
  listCalls: vi.fn(async () => []),
  getCall: vi.fn(async () => null)
}))
vi.mock('../deal-stages', () => ({ loadDealStages: vi.fn(() => []) }))
vi.mock('../personalization-context', () => ({
  assemblePersonalizationContext: vi.fn((p: unknown) => (p ? JSON.stringify(p) : ''))
}))
vi.mock('../app-settings', () => ({ loadAppSettings: vi.fn(() => ({ personalization: null })) }))

const { assembleContext, computeInputHash } = await import('../prep-brief-fs')
const { loadAppSettings } = await import('../app-settings')
const contactsById = contacts.byId
const contactsByEmail = contacts.byEmail

function baseInput(attendees: Array<{ email: string; name?: string }>): Parameters<typeof assembleContext>[0] {
  return {
    eventId: 'evt-1',
    title: 'Demo call',
    startIso: '2026-08-10T10:00:00.000Z',
    attendees
  }
}

beforeEach(() => {
  contactsById.clear()
  contactsByEmail.clear()
})

afterEach(() => {
  vi.mocked(loadAppSettings).mockReturnValue({
    personalization: null
  } as unknown as ReturnType<typeof loadAppSettings>)
})

describe('assembleContext — attendee contact matching', () => {
  it('still matches a single-attendee meeting (pre-existing behavior)', async () => {
    contactsByEmail.set('buyer@acme.com', { id: 'c1', updatedAt: 't1', email: 'buyer@acme.com' })
    const result = await assembleContext(baseInput([{ email: 'buyer@acme.com' }]))
    expect(result.contactId).toBe('c1')
  })

  it('matches a known contact even when the meeting has multiple attendees', async () => {
    // The bug: this used to be skipped entirely once attendees.length > 1.
    contactsByEmail.set('buyer@acme.com', { id: 'c1', updatedAt: 't1', email: 'buyer@acme.com' })
    const result = await assembleContext(
      baseInput([{ email: 'colleague@acme.com' }, { email: 'buyer@acme.com' }])
    )
    expect(result.contactId).toBe('c1')
  })

  it('finds the match regardless of which position it is in among several attendees', async () => {
    contactsByEmail.set('buyer@acme.com', { id: 'c1', updatedAt: 't1', email: 'buyer@acme.com' })
    const result = await assembleContext(
      baseInput([
        { email: 'nobody1@acme.com' },
        { email: 'buyer@acme.com' },
        { email: 'nobody2@acme.com' }
      ])
    )
    expect(result.contactId).toBe('c1')
  })

  it('leaves contact unset (not an error) when no attendee matches any known contact', async () => {
    const result = await assembleContext(
      baseInput([{ email: 'stranger1@x.com' }, { email: 'stranger2@x.com' }])
    )
    expect(result.contactId).toBeUndefined()
  })

  it('an explicit contactId still short-circuits attendee matching entirely', async () => {
    contactsById.set('c-explicit', { id: 'c-explicit', updatedAt: 't1' })
    contactsByEmail.set('buyer@acme.com', { id: 'c1', updatedAt: 't1', email: 'buyer@acme.com' })
    const input = { ...baseInput([{ email: 'buyer@acme.com' }]), contactId: 'c-explicit' }
    const result = await assembleContext(input)
    expect(result.contactId).toBe('c-explicit')
  })
})

describe('assembleContext — personalization cache invalidation', () => {
  it('includes personalization in hashInputs, so a settings change changes the hash', async () => {
    vi.mocked(loadAppSettings).mockReturnValue({
      personalization: { tone: 'formal' }
    } as unknown as ReturnType<typeof loadAppSettings>)
    const before = await assembleContext(baseInput([]))
    const hashBefore = computeInputHash(before.hashInputs)

    vi.mocked(loadAppSettings).mockReturnValue({
      personalization: { tone: 'casual' }
    } as unknown as ReturnType<typeof loadAppSettings>)
    const after = await assembleContext(baseInput([]))
    const hashAfter = computeInputHash(after.hashInputs)

    expect(hashBefore).not.toBe(hashAfter)
  })

  it('the hash stays stable when nothing, including personalization, actually changed', async () => {
    vi.mocked(loadAppSettings).mockReturnValue({
      personalization: { tone: 'formal' }
    } as unknown as ReturnType<typeof loadAppSettings>)
    const a = await assembleContext(baseInput([]))
    const b = await assembleContext(baseInput([]))
    expect(computeInputHash(a.hashInputs)).toBe(computeInputHash(b.hashInputs))
  })
})
