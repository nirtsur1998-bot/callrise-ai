// BUG-022 — the explicit "reset this device" escape hatch a genuinely
// different account uses after the sign-in ownership guard refuses it.
// Proves it actually removes every account-scoped store and connected-
// service secret, not just the owner marker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))

const clearAllAiKeys = vi.fn(async () => {})
vi.mock('../ai-keys', () => ({ clearAllAiKeys }))

const disconnectGoogle = vi.fn(async () => ({ ok: true }))
vi.mock('../google', () => ({ disconnect: disconnectGoogle }))

const disconnectOutlook = vi.fn(async () => ({ ok: true }))
vi.mock('../outlook', () => ({ disconnect: disconnectOutlook }))

const { wipeDeviceLocalData } = await import('../device-reset')

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'callrise-device-reset-'))
  clearAllAiKeys.mockClear()
  disconnectGoogle.mockClear()
  disconnectOutlook.mockClear()

  // Seed every account-scoped store with a real file, plus one directory
  // that must be left untouched (app-settings.json equivalent).
  for (const dir of ['calls', 'tasks', 'events', 'knowledge', 'contacts', 'deals', 'objection-queue', 'prep-briefs']) {
    await mkdir(join(userDataDir, dir), { recursive: true })
    await writeFile(join(userDataDir, dir, 'record.json'), '{}')
  }
  for (const file of [
    'backup-owner.json',
    'backup-state.json',
    'backup-pending-scrubs.json',
    'backup-pending-blob-deletes.json'
  ]) {
    await writeFile(join(userDataDir, file), '{}')
  }
  await writeFile(join(userDataDir, 'app-settings.json'), '{"keepMe":true}')
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('wipeDeviceLocalData', () => {
  it('deletes every account-scoped store directory', async () => {
    await wipeDeviceLocalData()
    for (const dir of ['calls', 'tasks', 'events', 'knowledge', 'contacts', 'deals', 'objection-queue', 'prep-briefs']) {
      expect(await exists(join(userDataDir, dir))).toBe(false)
    }
  })

  it('deletes the owner marker and backup-state bookkeeping files', async () => {
    await wipeDeviceLocalData()
    for (const file of [
      'backup-owner.json',
      'backup-state.json',
      'backup-pending-scrubs.json',
      'backup-pending-blob-deletes.json'
    ]) {
      expect(await exists(join(userDataDir, file))).toBe(false)
    }
  })

  it('leaves unrelated device configuration alone', async () => {
    await wipeDeviceLocalData()
    expect(await exists(join(userDataDir, 'app-settings.json'))).toBe(true)
  })

  it('disconnects Google, Outlook, and clears every AI key', async () => {
    await wipeDeviceLocalData()
    expect(disconnectGoogle).toHaveBeenCalledTimes(1)
    expect(disconnectOutlook).toHaveBeenCalledTimes(1)
    expect(clearAllAiKeys).toHaveBeenCalledTimes(1)
  })

  it('does not throw when a store directory never existed (fresh device, nothing to wipe)', async () => {
    await rm(userDataDir, { recursive: true, force: true })
    await mkdir(userDataDir, { recursive: true })
    await expect(wipeDeviceLocalData()).resolves.toBeUndefined()
  })
})
