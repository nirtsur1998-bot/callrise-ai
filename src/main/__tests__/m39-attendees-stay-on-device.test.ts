// @vitest-environment node
//
// M39 Stage 0 — attendee emails are persisted LOCALLY and never uploaded.
//
// Two claims, and only the second is dangerous:
//   1. the local store keeps `attendees` (the identity ladder's primary rung
//      cannot exist without them)
//   2. `eventPayload` — the one place an event becomes an upload — carries none
//
// (2) is asserted against the WHOLE SERIALISED PAYLOAD rather than by checking
// that a helper was called. That is BUG-209's lesson exactly: eleven green
// tests of `scrubProviderForEgress` would all have stayed green with the call
// to it deleted, because the helper working is not the claim. The claim is
// what the push uploads.
//
// It matters here more than it did there. `eventPayload` builds its payload
// with `{ ...e }`, so EVERY FIELD ADDED TO CalendarEvent FROM NOW ON SHIPS TO
// SUPABASE BY DEFAULT — which is how BUG-209 pushed the user's own Google
// account address on every event row, every cycle, for months, under a card
// saying it stayed on this device. These are third-party addresses belonging to
// people who never agreed to anything here.
//
// A THIRD claim was added after the first two passed, because they did not
// cover it and it was false: that anything WRITES the field at all. The first
// six tests prove the sanitizer KEEPS attendees when handed them; every one of
// them passed while no code path anywhere could produce them, because
// `EventCreateInput` had no such key. That is species 101 — "a field has a
// lifetime, not a birth" — and it is the same shape as `endedAt`: a green test
// file named after the write, and the field absent on 196 of 196 real records.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/tmp/m39-test', getVersion: () => '0.0.0-test' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showSaveDialog: vi.fn() }
}))

const { eventPayload } = await import('../backup')
const { sanitizeEventRecord, createEvent, updateEvent, getEvent, setEventSync } =
  await import('../events-fs')

const BUYER = 'sarah.chen@acme-example.com'
const SECOND = 'finance@acme-example.com'

const baseEvent = {
  id: 'evt-1',
  title: 'Renewal call',
  start: '2026-09-10T10:00:00.000Z',
  end: '2026-09-10T10:30:00.000Z',
  updatedAt: '2026-09-10T09:00:00.000Z',
  createdAt: '2026-09-10T09:00:00.000Z',
  allDay: false,
  source: 'local' as const
}

describe('M39 — the local store keeps who was invited', () => {
  it('persists attendees through the sanitizer', () => {
    const rec = sanitizeEventRecord({
      ...baseEvent,
      attendees: [{ email: BUYER, name: 'Sarah Chen' }]
    })
    expect(rec?.attendees).toEqual([{ email: BUYER, name: 'Sarah Chen' }])
  })

  it('lowercases and dedupes, so two spellings are one person', () => {
    const rec = sanitizeEventRecord({
      ...baseEvent,
      attendees: [{ email: 'Sarah.Chen@Acme-Example.com' }, { email: BUYER }, { email: SECOND }]
    })
    expect(rec?.attendees?.map((a) => a.email)).toEqual([BUYER, SECOND])
  })

  it('drops a row with no usable address — it can only ever be noise', () => {
    // An attendee without an email cannot resolve to a contact. Keeping it
    // would make `bestOneOnOneMatch` see two attendees where there is one
    // identifiable person, and refuse a match it should have made.
    const rec = sanitizeEventRecord({
      ...baseEvent,
      attendees: [{ email: BUYER }, { name: 'No Address' }, { email: 'not-an-email' }]
    })
    expect(rec?.attendees).toEqual([{ email: BUYER }])
  })

  it('bounds the list — a mail-merge invite must not land in every read', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ email: `p${i}@example.com` }))
    expect(sanitizeEventRecord({ ...baseEvent, attendees: many })?.attendees?.length).toBe(25)
  })

  it('is absent, not empty, when there are no attendees', () => {
    // `undefined` rather than `[]` so JSON.stringify omits it entirely and an
    // event with no invitees costs nothing on disk.
    expect(sanitizeEventRecord({ ...baseEvent, attendees: [] })?.attendees).toBeUndefined()
    expect(sanitizeEventRecord(baseEvent)?.attendees).toBeUndefined()
  })

  it('survives junk without throwing', () => {
    for (const junk of [null, 'nope', 42, { email: BUYER }]) {
      expect(sanitizeEventRecord({ ...baseEvent, attendees: junk })?.attendees).toBeUndefined()
    }
  })
})

describe('M39 — and NOTHING carries them off the device', () => {
  it('the whole serialised payload contains no attendee address', () => {
    // The claim, tested the only way it can honestly be tested: stringify what
    // the push would upload and search the bytes.
    const payload = eventPayload({
      ...baseEvent,
      attendees: [
        { email: BUYER, name: 'Sarah Chen' },
        { email: SECOND, name: 'Acme Finance' }
      ]
    } as never)

    const serialised = JSON.stringify(payload)
    expect(serialised).not.toContain(BUYER)
    expect(serialised).not.toContain(SECOND)
    expect(serialised).not.toContain('acme-example.com')
    expect(serialised).not.toContain('Sarah Chen')
    expect(serialised).not.toContain('attendees')
  })

  it('uploads the rest of the event unchanged — this strips one field, not the record', () => {
    // A strip that quietly took the title or the link with it would break the
    // backup while passing the test above.
    const payload = eventPayload({
      ...baseEvent,
      attendees: [{ email: BUYER }],
      contactId: 'c-1'
    } as never)
    expect(payload.id).toBe('evt-1')
    expect(payload.title).toBe('Renewal call')
    expect(payload.start).toBe(baseEvent.start)
    expect(payload.contactId).toBe('c-1')
  })

  it('an event with NO attendees is byte-identical to before this field existed', () => {
    // The regression that matters for everyone who never has invitees: the
    // majority case must not change shape at all.
    const withField = JSON.stringify(eventPayload({ ...baseEvent, attendees: undefined } as never))
    const without = JSON.stringify(eventPayload({ ...baseEvent } as never))
    expect(withField).toBe(without)
  })
})

describe('M39 — and something actually WRITES it, on disk, and keeps it there', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'callrise-m39-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const adoption = {
    title: 'Renewal call',
    start: '2026-09-10T10:00:00.000Z',
    end: '2026-09-10T10:30:00.000Z',
    provider: 'google:nir@example.com',
    externalId: 'goog-abc123',
    attendees: [{ email: BUYER, name: 'Sarah Chen' }]
  }

  it('createEvent writes attendees, and getEvent reads them back off the disk', async () => {
    // The birth. `createEvent` is the ONLY writer that builds the record from
    // nothing — every other path mutates one already read through
    // sanitizeEventRecord — so a field missing here is a field that never
    // exists, however many sanitizer tests are green.
    const made = await createEvent(dir, adoption)
    expect(made.attendees).toEqual([{ email: BUYER, name: 'Sarah Chen' }])

    const reread = await getEvent(dir, made.id)
    expect(reread?.attendees).toEqual([{ email: BUYER, name: 'Sarah Chen' }])
  })

  it('an adopted event keeps BOTH the provider link and the invitee list', async () => {
    // Adoption is the only moment the two can travel together: the provider
    // copy has the attendees, the local record is what can hold a contactId.
    // A create that took one and dropped the other would look fine in the UI.
    const made = await createEvent(dir, adoption)
    expect(made.externalId).toBe('goog-abc123')
    expect(made.attendees?.[0].email).toBe(BUYER)
  })

  it('an ordinary edit does NOT drop them — absent key means untouched', async () => {
    // The species-101 killer, and the likeliest real regression: a rep retitles
    // a meeting six weeks from now and the identity rung silently goes empty.
    const made = await createEvent(dir, adoption)
    const edited = await updateEvent(dir, made.id, { title: 'Renewal call — moved' })
    expect(edited?.title).toBe('Renewal call — moved')
    expect(edited?.attendees).toEqual([{ email: BUYER, name: 'Sarah Chen' }])
  })

  it('a sync confirmation does not rebuild the record without them', async () => {
    // BUG-187's exact mechanism, on a new field: `endedAt` was proven written
    // by a green test while a field-by-field record rebuild in the sync path
    // deleted it on all 196 live calls. setEventSync is this store's rebuild.
    const made = await createEvent(dir, adoption)
    await setEventSync(dir, made.id, {
      provider: 'google:nir@example.com',
      externalId: 'goog-abc123',
      sync: { state: 'synced' }
    })
    const after = await getEvent(dir, made.id)
    expect(after?.sync?.state).toBe('synced')
    expect(after?.attendees).toEqual([{ email: BUYER, name: 'Sarah Chen' }])
  })

  it('an explicit attendees patch replaces them, and junk clears them', async () => {
    const made = await createEvent(dir, adoption)
    const replaced = await updateEvent(dir, made.id, { attendees: [{ email: SECOND }] })
    expect(replaced?.attendees).toEqual([{ email: SECOND }])

    const cleared = await updateEvent(dir, made.id, { attendees: 'nonsense' })
    expect(cleared?.attendees).toBeUndefined()
  })

  it('a local event created without them stays exactly as it was', async () => {
    // Most events on a real store have no invitees at all (measured: the 3
    // cached Outlook events on the founder's machine are all solo). The
    // majority case must not gain a key.
    const made = await createEvent(dir, { title: 'Focus block', start: adoption.start })
    expect(made.attendees).toBeUndefined()
    expect(Object.keys(JSON.parse(JSON.stringify(made)))).not.toContain('attendees')
  })
})
