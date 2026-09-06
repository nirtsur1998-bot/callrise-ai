// BUG-169 — the renderer's view of a failed push, and the lockstep pin between
// the two copies of the failure words (main cannot be imported here).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { describeSyncFailure, orphanNoteOf, syncFailureOf, SYNC_FAILURE_TEXT } from '../syncFailure'
import { buildChipContext, type ChipContextSources } from '../chipContext'
import type { CalendarEvent, CalendarItem } from '../types'

const sources: ChipContextSources = {
  contactById: new Map(),
  dealById: new Map(),
  stageById: new Map(),
  briefStatusByEventId: new Map()
}
const ev = (over: Partial<CalendarEvent>): CalendarEvent =>
  ({ id: 'e1', title: 'Sync with Acme', start: '2026-09-06T09:00:00.000Z', end: '2026-09-06T09:30:00.000Z', provider: 'google', ...over }) as CalendarEvent
const item = (event: CalendarEvent): CalendarItem =>
  ({ kind: 'event', id: event.id, title: event.title, start: new Date(event.start), end: new Date(event.end), allDay: false, event }) as unknown as CalendarItem

describe('syncFailureOf', () => {
  it('a dirty or error state carries a reason; synced, local-only, deleted and absent carry nothing', () => {
    expect(syncFailureOf(ev({ sync: { state: 'error', lastError: 'forbidden' } }))?.reason).toMatch(/^Not on Google Calendar: the calendar refused it/)
    expect(syncFailureOf(ev({ sync: { state: 'dirty', lastError: 'offline' } }))?.state).toBe('dirty')
    expect(syncFailureOf(ev({ sync: { state: 'synced', lastPushedAt: 'x' } }))).toBeNull()
    expect(syncFailureOf(ev({ sync: { state: 'local-only' } }))).toBeNull()
    expect(syncFailureOf(ev({ sync: { state: 'deleted' } }))).toBeNull()
    expect(syncFailureOf(ev({}))).toBeNull()
    expect(syncFailureOf(undefined)).toBeNull()
  })
})

describe('the calendar chip carries the failure (records only, absent when synced)', () => {
  it('a failed push shows on the chip context; a synced event adds nothing', () => {
    const failed = buildChipContext(item(ev({ sync: { state: 'error', lastError: 'auth' } })), sources)
    expect(failed?.notSynced).toBe('Not on Google Calendar: your sign-in to the calendar expired.')
    const fine = buildChipContext(item(ev({ sync: { state: 'synced' } })), sources)
    expect(fine?.notSynced).toBeUndefined()
  })
})

describe('lockstep — the two copies of the failure words agree', () => {
  it('main and renderer list the same codes with the same words', () => {
    const mainSrc = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'main', 'events-sync-failure.ts'), 'utf8')
    const block = /SYNC_FAILURE_TEXT[^{]*\{([\s\S]*?)\n\}/.exec(mainSrc)?.[1] ?? ''
    const mainCodes = Object.fromEntries(
      [...block.matchAll(/^\s*'?([a-z-]+)'?:\s*'([^']*)'/gm)].map((m) => [m[1], m[2]])
    )
    expect(Object.keys(mainCodes).length, 'the main-side map was not parsed').toBeGreaterThanOrEqual(7)
    expect(SYNC_FAILURE_TEXT).toEqual(mainCodes)
  })
})

describe('describeSyncFailure (renderer copy) — the provider as it is actually stored', () => {
  it("names Outlook from 'outlook:<calendarId>'", () => {
    expect(describeSyncFailure('not-found', 'outlook:AQMkADAwATM3ZmYBLWI2OTUt')).toBe(
      'Not on Outlook: the calendar or the event no longer exists there.'
    )
  })
})

describe('orphanNoteOf — the reason line for an event whose calendar is gone', () => {
  it('says kept-here-only, names the provider and the date; nothing for an event that was never orphaned', () => {
    expect(orphanNoteOf({ orphaned: { provider: 'outlook:AQMk', externalId: 'x', reason: 'calendar-gone', at: '2026-09-05T12:00:00.000Z' } })).toBe(
      'Kept here only: the Outlook calendar it was on no longer exists (since 2026-09-05).'
    )
    expect(orphanNoteOf({})).toBeNull()
    expect(orphanNoteOf(null)).toBeNull()
  })
  it('matches main\'s orphanNote word for word (lockstep)', () => {
    const main = readFileSync(join(__dirname, '..', '..', '..', '..', '..', 'main', 'events.ts'), 'utf8')
    expect(main).toContain("`Kept here only: the ${where} calendar it was on no longer exists (since ${o.at.slice(0, 10)}).`")
  })
})
