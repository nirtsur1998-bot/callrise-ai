// BUG-029 — the Supabase session file was persisted with a fire-and-forget
// ASYNC writeFile, and before-quit had no hook to await it. Supabase rotates
// the refresh token roughly hourly while the app runs; a quit landing in the
// gap between setItem() being called and that async write actually finishing
// could leave the on-disk file holding the now-invalidated OLD token,
// bouncing the user to a surprise re-login next launch. Fixed by writing
// synchronously, which removes the gap entirely — no quit-time race to win
// or lose. This proves the write is complete and readable the instant
// setItem() RETURNS, with no extra tick/flush needed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A trivial reversible "encryption" is enough to prove the real read/write/
// decrypt round-trip through the file — the actual algorithm isn't what
// this test is about.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

const { makeFileStorage } = await import('../auth')

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-auth-storage-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('makeFileStorage', () => {
  it('setItem writes synchronously — the file is complete and decryptable the instant it returns', () => {
    const path = join(dir, 'session.enc')
    const storage = makeFileStorage(path)

    storage.setItem('sb-session', 'first-token')

    // No await, no setTimeout(0), no flush call — if this were still the old
    // async fire-and-forget write, the file could easily not exist yet here.
    expect(existsSync(path)).toBe(true)
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    expect(onDisk['sb-session']).toBe('first-token')
  })

  it('a token rotation (setItem called again) is fully persisted before the next setItem returns, simulating a quit right after', () => {
    const path = join(dir, 'session.enc')
    const storage = makeFileStorage(path)

    storage.setItem('sb-session', 'old-token')
    storage.setItem('sb-session', 'rotated-token') // e.g. Supabase's hourly refresh

    // A "quit" right here (no further ticks) must see the ROTATED token, not
    // a torn write or the stale pre-rotation one.
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    expect(onDisk['sb-session']).toBe('rotated-token')
  })

  it('removeItem is also synchronous', () => {
    const path = join(dir, 'session.enc')
    const storage = makeFileStorage(path)
    storage.setItem('sb-session', 'a-token')

    storage.removeItem('sb-session')

    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
    expect(onDisk['sb-session']).toBeUndefined()
  })

  it('a fresh instance reads back what a prior instance persisted (restart-survival)', () => {
    const path = join(dir, 'session.enc')
    makeFileStorage(path).setItem('sb-session', 'persisted-token')

    const reopened = makeFileStorage(path)
    expect(reopened.getItem('sb-session')).toBe('persisted-token')
  })
})
