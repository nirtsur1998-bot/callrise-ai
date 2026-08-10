// BUG-022 — the core "this device belongs to exactly one account" invariant
// that both backup.ts's cloud-sync guard and auth.ts's sign-in guard now
// share. Extracted from backup.ts into its own module specifically to avoid
// a circular import with auth.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string
vi.mock('electron', () => ({ app: { getPath: () => userDataDir } }))

const { readOwner, claimOwnershipIfUnset } = await import('../device-owner')

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'callrise-device-owner-'))
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('readOwner', () => {
  it('returns null when no owner file exists yet (fresh device)', async () => {
    expect(await readOwner()).toBeNull()
  })

  it('returns the pinned user id once claimed', async () => {
    await claimOwnershipIfUnset('user-a')
    expect(await readOwner()).toBe('user-a')
  })
})

describe('claimOwnershipIfUnset', () => {
  it('pins the FIRST account to sign in on a fresh device', async () => {
    await claimOwnershipIfUnset('user-a')
    expect(await readOwner()).toBe('user-a')
  })

  it('never overwrites an existing owner — a later different account cannot silently reclaim the device', async () => {
    await claimOwnershipIfUnset('user-a')
    await claimOwnershipIfUnset('user-b')
    expect(await readOwner()).toBe('user-a')
  })

  it('is a safe no-op when the same account claims again', async () => {
    await claimOwnershipIfUnset('user-a')
    await claimOwnershipIfUnset('user-a')
    expect(await readOwner()).toBe('user-a')
  })

  it('wins a race atomically — two concurrent claims never both succeed nor corrupt the file', async () => {
    await Promise.all([claimOwnershipIfUnset('user-a'), claimOwnershipIfUnset('user-b')])
    const owner = await readOwner()
    expect(['user-a', 'user-b']).toContain(owner)

    const raw = await readFile(join(userDataDir, 'backup-owner.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow() // never a torn/interleaved write
  })
})
