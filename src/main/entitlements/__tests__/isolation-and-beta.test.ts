// M29 B2 — two guarantees that must hold by construction:
//
// 1. The entitlements module never imports the remote-flags module. The
//    remote-flags memo's hard rule is "a flag can never grant or revoke a paid
//    feature"; a remotely-toggled enforcement switch would be a free-money
//    exploit if flipped off. This is the entitlements-side twin of
//    flags-cannot-reach-privacy — enforced by the import graph, not a comment.
//
// 2. During beta (ENTITLEMENTS_ENFORCED = false) the gate is open: every user
//    has every feature, exactly as the app behaves today.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const ENT_DIR = join(__dirname, '..')

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('structural: entitlements cannot reach the remote-flags module', () => {
  it('no source file under entitlements/ imports the flags module', () => {
    const files = readdirSync(ENT_DIR).filter((f) => f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const src = stripComments(readFileSync(join(ENT_DIR, f), 'utf8'))
      // Match an actual import of a `flags` module, not the word in prose.
      expect(src).not.toMatch(/from\s+['"][^'"]*\/flags['"]/)
      expect(src).not.toMatch(/from\s+['"]\.\.?\/flags['"]/)
      expect(src).not.toMatch(/require\(\s*['"][^'"]*flags['"]\s*\)/)
    }
  })

  it('enforcement is a local constant, not sourced from any config/flag lookup', () => {
    const idx = stripComments(readFileSync(join(ENT_DIR, 'index.ts'), 'utf8'))
    // The constant is a literal assignment, not read from env or a function.
    expect(idx).toMatch(/const ENTITLEMENTS_ENFORCED\s*=\s*(false|true)\b/)
  })
})

describe('beta posture: the gate is open while enforcement is off', () => {
  it('isEntitled returns true and never touches the token store during beta', async () => {
    const readCachedToken = vi.fn(() => 'should-not-be-read')
    vi.doMock('electron', () => ({ app: { getPath: () => '/tmp' } }))
    // NOTE the '../../': vi.doMock resolves relative to THIS file, not to the
    // module under test. `index.ts` imports '../auth' meaning `src/main/auth`,
    // but from here '../auth' would mean `src/main/entitlements/auth`, which
    // does not exist — so the mock silently missed and the REAL auth.ts (and
    // its supabase-js graph) loaded instead. The assertions still passed, so
    // the only symptom was ~2.5s of import time that tipped into a timeout
    // under full-suite load. A mock that does not intercept is a test entering
    // the wrong door; found by the suite, fixed here rather than by widening
    // the timeout.
    vi.doMock('../../auth', () => ({ getSignedInUserId: async () => 'user-1' }))
    vi.doMock('../store', async () => {
      const actual = await vi.importActual<typeof import('../store')>('../store')
      return { ...actual, readCachedToken }
    })
    const mod = await import('../index')
    expect(mod.ENTITLEMENTS_ENFORCED).toBe(false) // guards the assertion below
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await mod.isEntitled('_never' as any)).toBe(true)
    expect(readCachedToken).not.toHaveBeenCalled() // beta path shorts before the store
    vi.doUnmock('electron')
    vi.doUnmock('../../auth')
    vi.doUnmock('../store')
  })
})
