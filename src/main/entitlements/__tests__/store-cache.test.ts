// M29 B2 — the device-local token cache: encrypted round-trip, and the safe
// refusals (no encryption available → don't write plaintext; junk file → no
// cache, never a throw).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let encryptionAvailable = true

// A reversible stand-in for safeStorage: prefix-tag so the test can prove the
// file is not plaintext JSON, and decrypt only what this "encrypted".
// A reversible stand-in modeling real encryption: base64 of the content
// behind a tag, so the plaintext token is genuinely not readable at rest.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`ENC:${Buffer.from(s, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (b: Buffer) => {
      const s = b.toString('utf8')
      if (!s.startsWith('ENC:')) throw new Error('not encrypted by us')
      return Buffer.from(s.slice(4), 'base64').toString('utf8')
    }
  }
}))

const { readCachedToken, writeCachedToken } = await import('../store')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ent-store-'))
  encryptionAvailable = true
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('entitlement token cache', () => {
  it('round-trips a token through an encrypted file', () => {
    const p = join(dir, 'tok.enc')
    expect(writeCachedToken(p, 'claim.sig', 123)).toBe(true)
    expect(readCachedToken(p)).toBe('claim.sig')
  })

  it('the on-disk file is not plaintext (the token is encrypted at rest)', () => {
    const p = join(dir, 'tok.enc')
    writeCachedToken(p, 'super-secret-token', 123)
    const onDisk = require('node:fs').readFileSync(p, 'utf8') as string
    expect(onDisk).toContain('ENC:') // our stand-in's marker
    expect(onDisk).not.toContain('super-secret-token') // the token is not readable at rest
  })

  it('refuses to write a plaintext token when encryption is unavailable', () => {
    encryptionAvailable = false
    const p = join(dir, 'tok.enc')
    expect(writeCachedToken(p, 'claim.sig', 123)).toBe(false)
    expect(readCachedToken(p)).toBeNull()
  })

  it('a missing file is no cache, never a throw', () => {
    expect(readCachedToken(join(dir, 'nope.enc'))).toBeNull()
  })

  it('a corrupt/undecryptable file is no cache, never a throw', () => {
    const p = join(dir, 'bad.enc')
    writeFileSync(p, Buffer.from('garbage that we did not encrypt'))
    expect(readCachedToken(p)).toBeNull()
  })
})
