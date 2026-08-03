import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileStore, ts, type CloudRow } from '../backup-core'

interface Local {
  id: string
  updatedAt: string
  deleted?: boolean
  title?: string
}

function row(partial: Partial<CloudRow> & { id: string }): CloudRow {
  return {
    updated_at: partial.updated_at ?? '2026-01-01T00:00:00.000Z',
    server_updated_at: partial.server_updated_at ?? '2026-01-01T00:00:00.000Z',
    deleted: partial.deleted ?? false,
    payload: partial.payload ?? { id: partial.id, updatedAt: '2026-01-01T00:00:00.000Z' },
    ...partial
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-reconcile-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ts', () => {
  it('parses a real ISO timestamp', () => {
    expect(ts('2026-01-15T00:00:00.000Z')).toBe(Date.parse('2026-01-15T00:00:00.000Z'))
  })

  it('orders anything unparseable FIRST rather than crashing', () => {
    expect(ts(undefined)).toBe(0)
    expect(ts(null)).toBe(0)
    expect(ts('not a date')).toBe(0)
    expect(ts('')).toBe(0)
  })
})

describe('reconcileStore', () => {
  it('imports a cloud-only record', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const rows = [row({ id: 'a' })]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    expect(changed).toBe(1)
    expect(importRecord).toHaveBeenCalledOnce()
  })

  it('never imports a cloud tombstone for something never seen locally', async () => {
    const importRecord = vi.fn(async () => ({}) as Local)
    const rows = [row({ id: 'a', deleted: true })]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
  })

  it('leaves a local-only record alone (never appears in rows, so never touched)', async () => {
    const importRecord = vi.fn(async () => ({}) as Local)
    const locals = new Map<string, Local>([
      ['local-only', { id: 'local-only', updatedAt: '2026-01-01T00:00:00.000Z' }]
    ])
    const changed = await reconcileStore(dir, [], locals, importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
  })

  it('local wins when it is the same age or newer — no import, no conflict file', async () => {
    const importRecord = vi.fn(async () => ({}) as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-02-01T00:00:00.000Z' }]
    ])
    const rows = [row({ id: 'a', server_updated_at: '2026-01-01T00:00:00.000Z' })]
    const changed = await reconcileStore(dir, rows, locals, importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
    await expect(access(join(dir, 'a.conflict'))).rejects.toThrow()
  })

  it('cloud wins when newer, and imports it', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }]
    ])
    const rows = [row({ id: 'a', server_updated_at: '2026-02-01T00:00:00.000Z' })]
    const changed = await reconcileStore(dir, rows, locals, importRecord, undefined)
    expect(changed).toBe(1)
    expect(importRecord).toHaveBeenCalledOnce()
  })

  it('uses the server clock, never the device-supplied updated_at, to decide freshness', async () => {
    // A device with a fast clock inflates updated_at; server_updated_at is the
    // one source of truth this function is allowed to trust.
    const importRecord = vi.fn(async () => ({}) as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-03-01T00:00:00.000Z' }]
    ])
    const rows = [
      row({
        id: 'a',
        updated_at: '2099-01-01T00:00:00.000Z', // implausibly "future", but not trusted
        server_updated_at: '2026-01-01T00:00:00.000Z' // actually older than local
      })
    ]
    const changed = await reconcileStore(dir, rows, locals, importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
  })

  it('keeps the losing local copy as a .conflict file on a genuine two-machine concurrent edit', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const local: Local = { id: 'a', updatedAt: '2026-01-15T00:00:00.000Z', title: 'local edit' }
    const locals = new Map<string, Local>([['a', local]])
    const rows = [
      row({
        id: 'a',
        server_updated_at: '2026-01-20T00:00:00.000Z',
        payload: { id: 'a', updatedAt: '2026-01-20T00:00:00.000Z', title: 'cloud edit' }
      })
    ]
    // Local was edited (2026-01-15) AFTER the last sync (2026-01-10), while the
    // cloud was ALSO edited more recently (2026-01-20) — both sides changed.
    const changed = await reconcileStore(
      dir,
      rows,
      locals,
      importRecord,
      '2026-01-10T00:00:00.000Z'
    )
    expect(changed).toBe(1)
    const conflict = JSON.parse(await readFile(join(dir, 'a.conflict'), 'utf8'))
    expect(conflict.title).toBe('local edit')
  })

  it('does NOT write a conflict file when the local edit predates the last sync', async () => {
    // Local hasn't changed since the last sync — cloud winning is an ordinary
    // pull, not a concurrent-edit collision.
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-01-05T00:00:00.000Z' }]
    ])
    const rows = [row({ id: 'a', server_updated_at: '2026-01-20T00:00:00.000Z' })]
    await reconcileStore(dir, rows, locals, importRecord, '2026-01-10T00:00:00.000Z')
    await expect(access(join(dir, 'a.conflict'))).rejects.toThrow()
  })

  it('never writes a conflict file for a local record that is itself a tombstone', async () => {
    // A deleted local record losing to a cloud update is not a "concurrent
    // edit" worth preserving a copy of — there is nothing meaningful to keep.
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-01-15T00:00:00.000Z', deleted: true }]
    ])
    const rows = [row({ id: 'a', server_updated_at: '2026-01-20T00:00:00.000Z' })]
    await reconcileStore(dir, rows, locals, importRecord, '2026-01-10T00:00:00.000Z')
    await expect(access(join(dir, 'a.conflict'))).rejects.toThrow()
  })

  it('applies a cloud tombstone locally only when it is newer', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const locals = new Map<string, Local>([
      ['a', { id: 'a', updatedAt: '2026-01-01T00:00:00.000Z' }]
    ])
    const rows = [row({ id: 'a', deleted: true, server_updated_at: '2026-02-01T00:00:00.000Z' })]
    const changed = await reconcileStore(dir, rows, locals, importRecord, undefined)
    expect(changed).toBe(1)
    const [, payload] = importRecord.mock.calls[0]
    expect((payload as Record<string, unknown>).deleted).toBe(true)
  })

  it('skips a malformed row (no payload, or a non-object payload) without throwing', async () => {
    const importRecord = vi.fn(async () => ({}) as Local)
    const rows = [
      row({ id: 'a', payload: null }),
      row({ id: 'b', payload: 'not an object' }),
      row({ id: 'c', payload: undefined })
    ]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    expect(changed).toBe(0)
    expect(importRecord).not.toHaveBeenCalled()
  })

  it('does not count an import that the store rejected (importRecord returned null)', async () => {
    const importRecord = vi.fn(async () => null)
    const rows = [row({ id: 'a' })]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    expect(changed).toBe(0)
  })

  it('processes multiple rows independently and returns the total changed', async () => {
    const importRecord = vi.fn(async (_dir: string, payload: unknown) => payload as Local)
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c', deleted: true })]
    const changed = await reconcileStore(dir, rows, new Map(), importRecord, undefined)
    // 'a' and 'b' are cloud-only inserts; 'c' is a tombstone never seen locally.
    expect(changed).toBe(2)
  })
})
