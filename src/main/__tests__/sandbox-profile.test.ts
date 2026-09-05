// BUG-186 — a profile copy under CALLRISE_USER_DATA_DIR cannot reach the real
// cloud backup unless CALLRISE_SANDBOX_ALLOW_SYNC=1 is also set.
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  backupRefusedForSandbox,
  describeSandboxProfile,
  isSandboxProfile,
  markSandboxProfile,
  resetSandboxProfileForTests,
  sandboxRefusesSync
} from '../sandbox-profile'

afterEach(() => resetSandboxProfileForTests())

describe('sandboxRefusesSync — the rule', () => {
  it('a real profile (no override) never refuses, whatever the allow flag says', () => {
    expect(sandboxRefusesSync(undefined, false)).toBe(false)
    expect(sandboxRefusesSync(null, true)).toBe(false)
    expect(sandboxRefusesSync('', false)).toBe(false)
  })
  it('an overridden profile refuses unless explicitly allowed', () => {
    expect(sandboxRefusesSync('C:/tmp/sandbox-copy', false)).toBe(true)
    expect(sandboxRefusesSync('C:/tmp/sandbox-copy', true)).toBe(false)
  })
})

describe('the module state backup.ts reads', () => {
  it('starts as a real profile: nothing refused', () => {
    expect(isSandboxProfile()).toBe(false)
    expect(backupRefusedForSandbox()).toBe(false)
    expect(describeSandboxProfile()).toBeNull()
  })
  it('marked as a sandbox without the allow flag: refused, and the launch line says so', () => {
    markSandboxProfile('C:/tmp/sandbox-copy', false)
    expect(isSandboxProfile()).toBe(true)
    expect(backupRefusedForSandbox()).toBe(true)
    expect(describeSandboxProfile()).toMatch(/REFUSED/)
    expect(describeSandboxProfile()).toContain('CALLRISE_SANDBOX_ALLOW_SYNC=1')
  })
  it('marked with the allow flag: allowed, and the launch line WARNS that it will reach the backend', () => {
    markSandboxProfile('C:/tmp/sandbox-copy', true)
    expect(backupRefusedForSandbox()).toBe(false)
    expect(describeSandboxProfile()).toMatch(/WILL reach the real backend/)
  })
  it('marked with no override (a real profile) is not a sandbox', () => {
    markSandboxProfile(undefined, true)
    expect(isSandboxProfile()).toBe(false)
    expect(backupRefusedForSandbox()).toBe(false)
  })
})

describe('wiring, pinned as text (index.ts and backup.ts cannot be imported here)', () => {
  const read = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf8')

  it('index.ts marks the sandbox from the ONE override read, and reads the allow flag exactly once', () => {
    const src = read('index.ts')
    expect(src).toMatch(/markSandboxProfile\(devProfileOverride, process\.env\['CALLRISE_SANDBOX_ALLOW_SYNC'\] === '1'\)/)
    expect((src.match(/CALLRISE_SANDBOX_ALLOW_SYNC/g) ?? []).length).toBe(1)
    expect(src).toContain('describeSandboxProfile()')
  })

  it('backup.ts refuses BOTH push and pull before touching the client', () => {
    const src = read('backup.ts')
    const push = src.slice(src.indexOf('export async function pushAll('), src.indexOf('export async function pullAll('))
    const pull = src.slice(src.indexOf('export async function pullAll('), src.indexOf('export async function syncNow('))
    for (const [name, body] of [['pushAll', push], ['pullAll', pull]] as const) {
      const guard = body.indexOf('backupRefusedForSandbox()')
      const client = body.indexOf('getSupabaseClient()')
      expect(guard, `${name} has no sandbox guard`).toBeGreaterThan(0)
      expect(guard, `${name}: the guard must run BEFORE the client is obtained`).toBeLessThan(client)
      expect(body).toContain("error: 'sandbox'")
    }
  })

  it('the refusal is a named error the UI can word, not a silent no-op', () => {
    const card = read('../renderer/src/features/backup/BackupCard.tsx')
    expect(card).toContain("'sandbox'")
  })
})
