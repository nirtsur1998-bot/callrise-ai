// M31 Slice B — the meeting→call link, joining the plan to its outcome.
//
// The rule being defended: this link is only ever RECORDED, at the moment it
// is a fact (call-save time, when the app already knows which meeting is
// running). It is never inferred afterwards from "same contact, overlapping
// time", because that guess breaks on back-to-back calls with one contact, a
// call that overruns into the next slot, and a call made to someone else
// mid-meeting — and a link that is usually right is worse than none, since it
// teaches the rep to trust it before the case where it misleads them.
//
// These tests pin the storage contract that makes the guess impossible: the
// field only ever holds what was explicitly written, is validated like every
// other id, and can be cleared but never invented.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../google-sync', () => ({ linkKey: vi.fn(() => 'k') }))

const { createEvent, updateEvent, getEvent } = await import('../events-fs')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-events-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function newEvent(): Promise<string> {
  const e = await createEvent(dir, {
    title: 'Renewal call',
    start: '2026-09-01T11:00:00.000Z',
    end: '2026-09-01T11:30:00.000Z'
  })
  return e.id
}

describe('CalendarEvent.callId', () => {
  it('is absent on a newly created meeting — nothing has happened yet', async () => {
    const id = await newEvent()
    expect((await getEvent(dir, id))?.callId).toBeUndefined()
  })

  it('records the call that was actually recorded during the meeting', async () => {
    const id = await newEvent()
    await updateEvent(dir, id, { callId: 'abc-123' })
    expect((await getEvent(dir, id))?.callId).toBe('abc-123')
  })

  it('leaves the link untouched when the key is absent from a patch', async () => {
    const id = await newEvent()
    await updateEvent(dir, id, { callId: 'abc-123' })
    // A normal edit from the event dialog never mentions callId.
    await updateEvent(dir, id, { title: 'Renewal call (moved)' })
    const after = await getEvent(dir, id)
    expect(after?.title).toBe('Renewal call (moved)')
    expect(after?.callId).toBe('abc-123')
  })

  it('takes the most recent call when a meeting hosts more than one recording', async () => {
    // Last-write-wins is the documented rule: after a stop/restart, the link
    // should point at the real recording, not the aborted first attempt.
    const id = await newEvent()
    await updateEvent(dir, id, { callId: 'first-attempt' })
    await updateEvent(dir, id, { callId: 'the-real-one' })
    expect((await getEvent(dir, id))?.callId).toBe('the-real-one')
  })

  it('clears the link when explicitly unset, rather than keeping a dead id', async () => {
    const id = await newEvent()
    await updateEvent(dir, id, { callId: 'abc-123' })
    await updateEvent(dir, id, { callId: null })
    expect((await getEvent(dir, id))?.callId).toBeUndefined()
  })

  it('refuses a malformed id rather than storing something unopenable', async () => {
    const id = await newEvent()
    await updateEvent(dir, id, { callId: '../../etc/passwd' })
    expect((await getEvent(dir, id))?.callId).toBeUndefined()
  })

  it('cannot be set at creation — the outcome cannot predate the meeting', async () => {
    // EventCreateInput has no callId, so even a caller that tries gets
    // nothing: the link can only be added later, by the save path.
    const e = await createEvent(dir, {
      title: 'Renewal call',
      start: '2026-09-01T11:00:00.000Z',
      end: '2026-09-01T11:30:00.000Z',
      // @ts-expect-error -- deliberately not part of the create contract
      callId: 'sneaked-in'
    })
    expect(e.callId).toBeUndefined()
  })
})
