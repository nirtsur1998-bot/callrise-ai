// BUG-276 — saving a call must not push the running meeting to Outlook.
//
// `LiveView.handleSaved` writes `{ callId }` onto the current local meeting
// (M31 Slice B). `events:update` then did what it does for every edit:
// schedulePush(id). In readwrite mode that turned a `local-only` meeting into
// an Outlook event the moment a call was saved during it — driven on the
// founder's real profile on 2026-09-14 ("Linda — quarterly check-in",
// `sync: synced, lastPushedAt 09:52:58Z`).
//
// The join is app metadata, not a calendar edit the rep made. These tests pin
// (1) the classifier that tells the two apart and (2) that the handler consults
// it before scheduling a push — and nothing else about the handler changed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/nonexistent' }, ipcMain: { handle: vi.fn(), on: vi.fn() } }))

const { isInternalAnnotation, INTERNAL_EVENT_FIELDS } = await import('../events')

describe('BUG-276 — isInternalAnnotation', () => {
  it('the call-save join is internal', () => {
    expect(isInternalAnnotation({ callId: 'c1' })).toBe(true)
  })
  it('anything a rep edits is not — even alongside callId', () => {
    expect(isInternalAnnotation({ title: 'Renamed' })).toBe(false)
    expect(isInternalAnnotation({ callId: 'c1', title: 'Renamed' })).toBe(false)
    expect(isInternalAnnotation({ start: '2026-09-14T10:00:00.000Z' })).toBe(false)
    expect(isInternalAnnotation({ contactId: 'x' })).toBe(false)
  })
  it('an empty or malformed patch is not internal (it must keep today\'s behaviour)', () => {
    expect(isInternalAnnotation({})).toBe(false)
    expect(isInternalAnnotation(null)).toBe(false)
    expect(isInternalAnnotation('callId')).toBe(false)
  })
  it('the internal-field list is exactly the join, so a new app-only field is a deliberate addition', () => {
    expect([...INTERNAL_EVENT_FIELDS]).toEqual(['callId'])
  })
})

describe('BUG-276 — the update handler consults it before pushing', () => {
  const src = readFileSync(join(__dirname, '..', 'events.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const handler = src.match(/ipcMain\.handle\('events:update'[\s\S]*?\n\s*\}\)\n/)

  it('events:update exists and pushes only when the patch is not an internal annotation', () => {
    expect(handler, 'events:update handler must exist').not.toBeNull()
    expect(handler![0]).toContain('if (!isInternalAnnotation(patch)) schedulePush(id)')
    // The backup and the broadcast are NOT gated — a join still has to reach
    // the cloud mirror and every open calendar view.
    expect(handler![0]).toContain('scheduleBackup()')
    expect(handler![0]).toContain('notifyEventsChanged()')
  })

  it('events:create still pushes unconditionally (a rep creating a meeting is an edit)', () => {
    const create = src.match(/ipcMain\.handle\('events:create'[\s\S]*?\n\s*\}\)\n/)
    expect(create).not.toBeNull()
    expect(create![0]).toMatch(/^\s*schedulePush\(event\.id\)/m)
  })

  it('LiveView writes the join with exactly { callId } — the shape the classifier recognises', () => {
    const view = readFileSync(
      join(__dirname, '..', '..', 'renderer', 'src', 'features', 'live', 'LiveView.tsx'),
      'utf8'
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    expect(view).toMatch(/window\.api\.events\.update\(meeting\.id, \{ callId \}\)/)
  })
})
