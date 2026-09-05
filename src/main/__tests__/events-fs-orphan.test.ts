// Founder's decision (2026-09-05): an event whose provider calendar no longer
// exists becomes local-only — and the record says why, so nobody mistakes it
// for a deliberately local event later.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEvent, getEvent, importEvent, orphanEvent, setEventSync } from '../events-fs'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'events-orphan-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

async function linkedEvent(): Promise<string> {
  const e = await createEvent(dir, {
    title: 'Frank - Upsell follow up',
    start: '2026-08-13T06:00:00.000Z',
    end: '2026-08-13T07:00:00.000Z',
    allDay: false
  })
  await setEventSync(dir, e!.id, {
    provider: 'outlook:AQMkADAwATM3ZmYBLWI2OTUt',
    externalId: 'AAMkAGdead',
    sync: { state: 'error', lastError: 'not-found' }
  })
  return e!.id
}

describe('orphanEvent', () => {
  it('turns a linked, not-found event into local-only and keeps the old link as the reason', async () => {
    const id = await linkedEvent()
    const before = (await getEvent(dir, id))!
    const o = await orphanEvent(dir, id)
    expect(o?.sync).toEqual({ state: 'local-only' })
    expect(o?.provider).toBeUndefined()
    expect(o?.externalId).toBeUndefined()
    expect(o?.orphaned).toMatchObject({
      provider: 'outlook:AQMkADAwATM3ZmYBLWI2OTUt',
      externalId: 'AAMkAGdead',
      reason: 'calendar-gone'
    })
    expect(Date.parse(o!.orphaned!.at)).toBeGreaterThan(0)
    expect(Date.parse(o!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt)) // reaches the cloud
    // and it is on DISK that way, through the sanitizer
    const raw = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'))
    expect(raw.orphaned.reason).toBe('calendar-gone')
    expect((await getEvent(dir, id))!.orphaned?.externalId).toBe('AAMkAGdead')
  })

  it('is idempotent, and refuses an event that was never linked (nothing to be orphaned from)', async () => {
    const id = await linkedEvent()
    const first = await orphanEvent(dir, id)
    const second = await orphanEvent(dir, id)
    expect(second?.orphaned).toEqual(first?.orphaned)

    const never = await createEvent(dir, {
      title: 'local from birth',
      start: '2026-09-01T06:00:00.000Z',
      end: '2026-09-01T07:00:00.000Z',
      allDay: false
    })
    expect(await orphanEvent(dir, never!.id)).toBeNull()
    expect((await getEvent(dir, never!.id))!.orphaned).toBeUndefined()
  })

  it('a cloud pull whose payload predates the orphan note does not erase it (absent-key rule)', async () => {
    const id = await linkedEvent()
    await orphanEvent(dir, id)
    const stale = { ...(await getEvent(dir, id))!, updatedAt: '2999-01-01T00:00:00.000Z' } as Record<string, unknown>
    delete stale.orphaned
    const imported = await importEvent(dir, stale, { onlyIfNewer: true })
    expect(imported?.orphaned?.reason).toBe('calendar-gone')
    expect((await getEvent(dir, id))!.orphaned?.externalId).toBe('AAMkAGdead')
  })

  it('a malformed orphan note on disk is dropped rather than trusted', async () => {
    const id = await linkedEvent()
    const imported = await importEvent(dir, {
      ...(await getEvent(dir, id))!,
      orphaned: { provider: 'outlook:x' }, // no externalId, no at
      updatedAt: '2999-01-01T00:00:00.000Z'
    })
    expect(imported?.orphaned).toBeUndefined()
  })
})

describe('the push path and the startup sweep use it (pinned as text: events.ts needs electron)', () => {
  const src = readFileSync(join(__dirname, '..', 'events.ts'), 'utf8')
  it("recordPushResult sends a linked 'not-found' to orphanEvent instead of the error state", () => {
    const i = src.indexOf('async function recordPushResult(')
    const body = src.slice(i, src.indexOf('\n}\n', i) > 0 ? src.indexOf('\n}\n', i) : i + 4000)
    expect(body).toMatch(/res\.error === 'not-found' && cur\.externalId/)
    expect(body).toContain('await orphanEvent(eventsDir(), id)')
  })
  it('orphanNotFoundEvents exists and runs at registration', () => {
    expect(src).toContain('export async function orphanNotFoundEvents(')
    expect(src).toMatch(/registerEvents\(\): void \{[\s\S]*void orphanNotFoundEvents\(\)/)
  })
})
