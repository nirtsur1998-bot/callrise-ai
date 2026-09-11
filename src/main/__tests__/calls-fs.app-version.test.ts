// M39 — `appVersion` on the call record: which build WROTE this call.
//
// It exists because a question could not be answered. `endedAt` was absent on
// 297 of 297 real calls, including one saved after the fix that should have
// kept it, and "old build or failing fix?" had no answer: nothing on a call
// record names the build that wrote it, and `updatedAt` is restamped on every
// file by BUG-185. Founder-approved, 2026-09-11: one field, additive, absent on
// existing records rather than backfilled.
//
// The properties below are the ones that make the field worth trusting, not
// merely present:
//   - main supplies it; a value in the renderer's payload is IGNORED, because a
//     field that decides which build to blame must not be writable by the build
//     being blamed;
//   - absent means absent — no "unknown", no default, no backfill;
//   - a sync cannot delete it (the exact way `endedAt` was lost);
//   - EVERY save path stamps it, enumerated from the source rather than from
//     memory — there are two, and forgetting the recovery one would make the
//     field absent on exactly the calls most likely to be investigated.
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveCall, keepLocalCallFields, CALL_FIELD_RULES, type CallSegment } from '../calls-fs'

const segments: CallSegment[] = [
  { speaker: 0, text: 'thanks for the time today', role: 'rep' },
  { speaker: 1, text: 'no problem at all', role: 'other' }
]
const base = { startedAt: '2026-09-11T07:28:00.000Z', durationMs: 342_000, segments }

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'appversion-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const readOnly = (): Record<string, unknown> => {
  const f = readdirSync(dir).filter((x) => x.endsWith('.json'))
  expect(f).toHaveLength(1)
  return JSON.parse(readFileSync(join(dir, f[0]), 'utf8'))
}

describe('M39 — appVersion names the build that wrote the call', () => {
  it('stamps the version main supplies', async () => {
    await saveCall(dir, base, { appVersion: '1.12.0' })
    expect(readOnly().appVersion).toBe('1.12.0')
  })

  it('IGNORES a version in the renderer payload', async () => {
    // The renderer is the thing whose build we may be trying to identify. If
    // it could write this field, a stale renderer could claim a new build.
    await saveCall(dir, { ...base, appVersion: '9.9.9' } as never, { appVersion: '1.12.0' })
    expect(readOnly().appVersion).toBe('1.12.0')
  })

  it('a renderer-supplied version with NO main value still does not land', async () => {
    await saveCall(dir, { ...base, appVersion: '9.9.9' } as never)
    expect(readOnly()).not.toHaveProperty('appVersion')
  })

  it('is ABSENT, not "unknown", when main supplies nothing', async () => {
    // "An absent field is honest; a backfilled one is a lie with a timestamp."
    await saveCall(dir, base)
    expect(readOnly()).not.toHaveProperty('appVersion')
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['a newline smuggled in', '1.12.0\nINJECTED'],
    ['absurdly long', '1.'.repeat(40)],
    ['not a string', 42 as unknown as string]
  ])('refuses a malformed version (%s) rather than storing it', async (_label, value) => {
    await saveCall(dir, base, { appVersion: value })
    expect(readOnly()).not.toHaveProperty('appVersion')
  })

  it('accepts the shapes a real build reports', async () => {
    for (const v of ['1.11.2', '1.12.0-beta.1', '2.0.0+build.7']) {
      rmSync(dir, { recursive: true, force: true })
      dir = mkdtempSync(join(tmpdir(), 'appversion-'))
      await saveCall(dir, base, { appVersion: v })
      expect(readOnly().appVersion).toBe(v)
    }
  })
})

describe('M39 — a sync cannot delete it, which is how endedAt was lost', () => {
  it('is carried across a restore-merge as local-only', () => {
    // keepLocalCallFields derives its key set from CALL_RESTORE_RULES, so this
    // is the table's own answer, not a second list kept in step with it.
    const kept = keepLocalCallFields({ appVersion: '1.12.0' } as never)
    expect(kept).toHaveProperty('appVersion', '1.12.0')
  })

  it('is classified as METADATA — a version string carries no speech', () => {
    expect(CALL_FIELD_RULES.appVersion.cls).toBe('METADATA')
  })
})

describe('M39 — EVERY save path stamps it', () => {
  // Enumerated from the source. There are two callers today — the normal save
  // in calls.ts and interrupted-call recovery in live-transcript-ipc.ts — and
  // missing the second would leave the field absent on precisely the calls
  // most likely to be investigated: the ones that went wrong.
  const MAIN = join(__dirname, '..')
  const walk = (d: string, out: string[] = []): string[] => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name)
      if (name.isDirectory()) {
        if (name.name !== '__tests__') walk(p, out)
      } else if (name.name.endsWith('.ts')) out.push(p)
    }
    return out
  }
  const strip = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  /** The full argument list of each `saveCall(` call, balancing parentheses —
   *  the recovery call spreads a conditional object, so a regex would stop at
   *  the first `)`. */
  const callSites = (): { file: string; args: string }[] => {
    const out: { file: string; args: string }[] = []
    for (const f of walk(MAIN)) {
      const code = strip(readFileSync(f, 'utf8'))
      let from = 0
      for (;;) {
        const at = code.indexOf('saveCall(', from)
        if (at === -1) break
        from = at + 1
        if (/function\s+$/.test(code.slice(Math.max(0, at - 20), at))) continue
        let depth = 0
        let end = at + 'saveCall'.length
        for (; end < code.length; end++) {
          if (code[end] === '(') depth++
          else if (code[end] === ')' && --depth === 0) break
        }
        out.push({ file: f.slice(MAIN.length + 1), args: code.slice(at, end + 1) })
      }
    }
    return out
  }

  it('found the save paths at all (a silent zero would make this vacuous)', () => {
    expect(callSites().length).toBeGreaterThanOrEqual(2)
  })

  it('each one passes main’s own version', () => {
    const missing = callSites()
      .filter((s) => !/appVersion:\s*currentAppVersion\(\)/.test(s.args))
      .map((s) => s.file)
    expect(missing, 'these save paths write a call with no appVersion').toEqual([])
  })
})
