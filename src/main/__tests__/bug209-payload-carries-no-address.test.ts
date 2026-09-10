// @vitest-environment node
//
// BUG-209 — the CALL SITE, not the helper.
//
// Its sibling file tests `scrubProviderForEgress` and `resolveProviderFromEgress`
// directly, and every one of those 11 tests would stay GREEN if somebody deleted
// the call to the scrub from `eventPayload`. The helper working is not the
// claim; the claim is that **what the push uploads carries no account address**,
// and only a test of the payload itself can make that.
//
// This is the same shape as species 107: a set of green tests that never
// exercise the path the bug lives on. Written after noticing it in this fix's
// own red-check, before reverting anything.
import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/tmp/bug209-test', getVersion: () => '0.0.0-test' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showSaveDialog: vi.fn() }
}))

const ADDRESS = 'dana.whitfield@example.com'

const baseEvent = {
  id: 'evt-1',
  title: 'Renewal call',
  start: '2026-09-10T10:00:00.000Z',
  end: '2026-09-10T10:30:00.000Z',
  updatedAt: '2026-09-10T09:00:00.000Z',
  source: 'local' as const,
  externalId: 'abc123',
  sync: { state: 'synced' as const }
}

describe('BUG-209 — the uploaded payload', () => {
  beforeEach(async () => {
    const { setPrimaryCalendarId } = await import('../google-sync')
    setPrimaryCalendarId(ADDRESS)
  })

  it('carries NO account address anywhere in it', async () => {
    const { eventPayload } = await import('../backup')
    const payload = eventPayload({ ...baseEvent, provider: `google:${ADDRESS}` } as never)

    // The whole serialised payload, not just the field we happen to suspect —
    // the point is that the address is absent, not that one key was rewritten.
    expect(JSON.stringify(payload)).not.toContain(ADDRESS)
    expect(payload.provider).toBe('google:@primary')
  })

  it('still drops `sync`, which it did before this change', async () => {
    const { eventPayload } = await import('../backup')
    const payload = eventPayload({ ...baseEvent, provider: `google:${ADDRESS}` } as never)
    expect(payload.sync).toBeUndefined()
  })

  it('leaves a non-primary Google calendar and Outlook untouched', async () => {
    const { eventPayload } = await import('../backup')
    const group = 'google:c_9a3f7b21@group.calendar.google.com'
    const outlook = 'outlook:AQMkADAwATNiZmYAZS9kNzBiLTYxNzAtMDAC'
    expect(eventPayload({ ...baseEvent, provider: group } as never).provider).toBe(group)
    expect(eventPayload({ ...baseEvent, provider: outlook } as never).provider).toBe(outlook)
  })

  it('keeps externalId — it was checked and carries no identity', async () => {
    // Measured for Outlook (opaque 140-char tokens, 0 of 2 with an @) and read
    // from source for Google (a UUID-derived or opaque event id; `iCalUID`, the
    // field that DOES carry a domain, is never stored anywhere in src/).
    const { eventPayload } = await import('../backup')
    const payload = eventPayload({ ...baseEvent, provider: `google:${ADDRESS}` } as never)
    expect(payload.externalId).toBe('abc123')
  })
})
