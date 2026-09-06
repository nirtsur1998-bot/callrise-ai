// The Bug Tracker's status mechanism: headings carry no status, one Status:
// line per entry, the index is generated, and a body that has moved on from
// its status line is REFUSED rather than silently disagreeing (species 77).
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error — an .mjs script with no declaration file; the shape is asserted below
import { check, migrate, withIndex, main, deriveInitialStatus, parseTracker } from '../../scripts/verification/tracker-status.mjs'

const SAMPLE = `# 🐞 Bug Tracker

> intro

---

## 🎯 QUEUE

**Last updated:** 2026-09-05 — words.

### BUG-001 — a thing that was fixed but the heading never said so
- **Status:** [ ] Open — found during M21
- **Why:** because.

> ✅ **FIXED on the branch, 2026-08-20.** Commit abc.

### BUG-002 — still open (OPEN, not fixed)
- **Status:** [ ] Open — logged 2026-08-25

## BUG-003 — closed by evidence (CLOSED BY EVIDENCE 2026-09-05)
> ✅ **CLOSED BY EVIDENCE — 2026-09-05.** commit x on main.

### BUG-004 — deferred by decision (Windows)
- **Status:** [ ] Open — decided against, not forgotten
`

describe('migrate — one-time, from the shapes the real tracker has', () => {
  const { text, changes } = migrate(SAMPLE)
  const lines = text.split('\n')

  it('strips status parentheticals from headings and keeps a non-status one', () => {
    expect(lines).toContain('### BUG-002 — still open')
    expect(lines).toContain('## BUG-003 — closed by evidence')
    expect(lines).toContain('### BUG-004 — deferred by decision (Windows)')
    expect(changes.headingsStripped).toBe(2)
  })

  it('adds one canonical status line under every heading, derived from the body when the heading lied', () => {
    expect(text).toMatch(/### BUG-001 — a thing[^\n]*\n\*\*Status:\*\* FIXED · 2026-08-20/)
    expect(text).toMatch(/### BUG-002 — still open\n\*\*Status:\*\* OPEN · 2026-08-25/)
    expect(text).toMatch(/## BUG-003 — closed by evidence\n\*\*Status:\*\* CLOSED · 2026-09-05/)
    expect(text).toMatch(/### BUG-004 — deferred by decision \(Windows\)\n\*\*Status:\*\* DEFERRED · /)
    expect(changes.statusLinesAdded).toBe(4)
  })

  it('renames the legacy bullets so only ONE thing is called Status', () => {
    expect(text).not.toMatch(/^- \*\*Status:\*\*/m)
    expect(text).toContain('- **Status history:** [ ] Open — found during M21')
    expect(changes.legacyRenamed).toBe(3)
  })

  it('is idempotent — migrating the migrated text changes nothing', () => {
    const again = migrate(text)
    expect(again.text).toBe(text)
    expect(again.changes).toEqual({ headingsStripped: 0, statusLinesAdded: 0, legacyRenamed: 0 })
  })

  it('the migrated text passes the check', () => {
    expect(check(text).problems).toEqual([])
  })
})

describe('check — the clause that makes it real', () => {
  const clean = migrate(SAMPLE).text

  it('refuses when a body has a dated closure LATER than an OPEN status line', () => {
    const broken = clean.replace('**Status:** OPEN · 2026-08-25', '**Status:** OPEN · 2026-08-25') // unchanged so far
      .replace('### BUG-002 — still open\n**Status:** OPEN · 2026-08-25', '### BUG-002 — still open\n**Status:** OPEN · 2026-08-25\n\n> ✅ **FIXED 2026-09-01** in commit y.')
    const r = check(broken)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatch(/BUG-002 .*status says OPEN · 2026-08-25 but the body has a closure dated 2026-09-01/)
  })

  it('does not object to a closure OLDER than the status line (the entry was reopened on purpose)', () => {
    const reopened = clean.replace('### BUG-001 — a thing that was fixed but the heading never said so\n**Status:** FIXED · 2026-08-20', '### BUG-001 — a thing that was fixed but the heading never said so\n**Status:** OPEN · 2026-09-02 — reopened, regressed')
    expect(check(reopened).problems).toEqual([])
  })

  it('refuses a heading that still carries a status word in its parenthetical', () => {
    const r = check(clean.replace('### BUG-002 — still open', '### BUG-002 — still open (FIXED)'))
    expect(r.problems.some((p: string) => /BUG-002 .*heading still carries a status parenthetical/.test(p))).toBe(true)
  })

  it('refuses an entry with no status line', () => {
    const r = check(clean.replace('**Status:** DEFERRED', '**Nope:** DEFERRED'))
    expect(r.problems.some((p: string) => /BUG-004 .*no status line/.test(p))).toBe(true)
  })
})

describe('the generated index', () => {
  it('counts every state, lists each entry once, and is replaced in place on the next run', () => {
    const t = migrate(SAMPLE).text
    const { statuses } = check(t)
    const once = withIndex(t, statuses)
    expect(once).toContain('**Index — 4 entries: 1 OPEN · 1 FIXED · 1 CLOSED · 1 DEFERRED · 0 LOGGED.**')
    expect(once).toContain('| [[BUG-001]] | 2026-08-20 |')
    const twice = withIndex(once, statuses)
    expect(twice).toBe(once)
    expect((twice.match(/tracker-index:start/g) ?? []).length).toBe(1)
  })
})

describe('main — the CLI writes nothing on a disagreement', () => {
  it('exit 2 and an untouched file when a body outran its status line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-'))
    try {
      const f = join(dir, 'Bug Tracker.md')
      const t = migrate(SAMPLE).text.replace('### BUG-002 — still open\n**Status:** OPEN · 2026-08-25', '### BUG-002 — still open\n**Status:** OPEN · 2026-08-25\n\n> ✅ **FIXED 2026-09-01**')
      writeFileSync(f, t, 'utf8')
      const before = readFileSync(f, 'utf8')
      const code = main(['--file', f])
      expect(code).toBe(2)
      expect(readFileSync(f, 'utf8')).toBe(before)
      expect(main(['--check', '--file', f])).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exit 0 and the index written when clean', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tracker-'))
    try {
      const f = join(dir, 'Bug Tracker.md')
      writeFileSync(f, migrate(SAMPLE).text, 'utf8')
      expect(main(['--file', f])).toBe(0)
      expect(readFileSync(f, 'utf8')).toContain('tracker-index:start')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('deriveInitialStatus — the real tracker\'s legacy shapes', () => {
  const entry = (rest: string, body: string[]) => ({ rest, body, id: 'BUG-999', level: 3, line: 0, end: 0 })
  it('reads a [x] legacy bullet as FIXED with its date', () => {
    expect(deriveInitialStatus(entry(' — t', ['- **Status:** [x] **Fixed** 2026-08-10 — commit `abc`']))).toMatchObject({ state: 'FIXED', date: '2026-08-10' })
  })
  it('reads a heading parenthetical over a stale bullet', () => {
    expect(deriveInitialStatus(entry(' — t (FIXED, shipped v1.8.0)', ['- **Status:** [ ] Open — found 2026-08-10']))).toMatchObject({ state: 'FIXED' })
  })
  it('an entry with nothing at all is OPEN, and says so', () => {
    expect(deriveInitialStatus(entry(' — t', ['- **Why:** x']))).toMatchObject({ state: 'OPEN', note: 'no status recorded before the migration' })
  })
  it('a partial marker does not override an undated "[ ] Open" bullet; a full stamp does', () => {
    const partial = entry(' — t', ['- **Status:** [ ] **Open — measured, not fixed.**', '', '- **✅ FIX C BUILT (2026-08-25).** part of it.'])
    expect(deriveInitialStatus(partial)).toMatchObject({ state: 'OPEN' })
    const stamped = entry(' — t', ['- **Status:** [ ] Open — fix shape awaiting approval', '', '> ✅ **CLOSED BY EVIDENCE — 2026-09-05.** commit on main.'])
    expect(deriveInitialStatus(stamped)).toMatchObject({ state: 'CLOSED', date: '2026-09-05' })
  })
  it('a "REOPENED as UNVERIFIED" bullet wins over the older closure below it', () => {
    const e = entry(' — t', ['- **Status:** [ ] **REOPENED 2026-08-24 as UNVERIFIED.**', '', '**FIXED** 2026-08-20 in commit z.'])
    expect(deriveInitialStatus(e)).toMatchObject({ state: 'OPEN' })
  })
  it('a following non-BUG section does not bleed into the last entry (BUG-038 was read as fixed by the "Recently fixed" list)', () => {
    const t = '### BUG-038 — no test\n- **Status:** [ ] Open — found 2026-08-10\n\n## ✅ Recently fixed\n- [x] **Lag** — FIXED 2026-08-28.\n'
    const e = parseTracker(t).entries[0]
    expect(e.body).toEqual(['- **Status:** [ ] Open — found 2026-08-10', ''])
    expect(deriveInitialStatus(e)).toMatchObject({ state: 'OPEN' })
  })
  it('parseTracker sees the real heading levels and ids', () => {
    const p = parseTracker(SAMPLE)
    expect(p.entries.map((e: { id: string; level: number }) => [e.id, e.level])).toEqual([['BUG-001', 3], ['BUG-002', 3], ['BUG-003', 2], ['BUG-004', 3]])
  })
})
