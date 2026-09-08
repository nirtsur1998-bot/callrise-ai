// The two questions a crash dump raises, and for the life of the product only
// one of them had an answer.
//
// A minidump is a snapshot of PROCESS MEMORY. For this app that memory holds
// live transcript text, buyer speech, contact and deal records, and any AI
// provider key in use. index.ts carries a long, correct, emphatic warning
// about the FIRST question — does a dump ever leave this machine — and answers
// it: no, never, not behind a flag. The M29 audit called that the
// highest-consequence single line in the codebase.
//
// The SECOND question was never asked beside it: how long does it STAY on this
// machine. The answer was FOREVER. No age cap, no size cap, no sweep; the only
// code that ever touched a dump counted it. So `deleteCall`'s promise that a
// deleted call retains no buyer words was false for any call during which the
// app died hard, and stayed false, under a Crashpad-generated uuid filename no
// assertion could have been written for. That is BUG-139's shape, one
// directory further out.
//
// Founder's decision, 2026-09-08: fourteen days.
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { purgeOldDumps, DUMP_RETENTION_DAYS } from '../native-crashes'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0)

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crash-dumps-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A dump `ageDays` old, in a nested directory like Crashpad's own layout. */
function dump(name: string, ageDays: number, sub = 'reports'): string {
  const d = join(dir, sub)
  mkdirSync(d, { recursive: true })
  const p = join(d, name)
  writeFileSync(p, 'MDMP fake minidump bytes')
  const t = (NOW - ageDays * DAY) / 1000
  utimesSync(p, t, t)
  return p
}

describe('crash dumps expire', () => {
  it('deletes dumps past the window and keeps the ones inside it', () => {
    const old1 = dump('a.dmp', 30)
    const old2 = dump('b.dmp', 15)
    const edge = dump('c.dmp', 13)
    const fresh = dump('d.dmp', 1)

    const r = purgeOldDumps(dir, DUMP_RETENTION_DAYS, NOW)

    expect(r).toEqual({ deleted: 2, kept: 2, failed: 0 })
    expect(existsSync(old1), 'a 30-day-old dump survived').toBe(false)
    expect(existsSync(old2), 'a 15-day-old dump survived').toBe(false)
    expect(existsSync(edge), 'a 13-day-old dump was deleted early').toBe(true)
    expect(existsSync(fresh), "yesterday's dump was deleted").toBe(true)
  })

  it('walks the nested layout Crashpad actually writes', () => {
    // Crashpad nests under reports/, pending/, completed/. A purge that only
    // read the top level would delete nothing at all and report success.
    const a = dump('a.dmp', 30, 'reports')
    const b = dump('b.dmp', 30, join('pending', 'inner'))
    const c = dump('c.dmp', 30, 'completed')

    const r = purgeOldDumps(dir, DUMP_RETENTION_DAYS, NOW)

    expect(r.deleted, 'nested dumps were not found').toBe(3)
    for (const p of [a, b, c]) expect(existsSync(p)).toBe(false)
  })

  it('touches nothing that is not a dump', () => {
    // The directory belongs to Crashpad, not to us: settings, metadata and
    // lock files live there too.
    const keepMe = join(dir, 'settings.dat')
    writeFileSync(keepMe, 'crashpad state')
    const t = (NOW - 400 * DAY) / 1000
    utimesSync(keepMe, t, t)
    dump('a.dmp', 30)

    const r = purgeOldDumps(dir, DUMP_RETENTION_DAYS, NOW)

    expect(r.deleted).toBe(1)
    expect(existsSync(keepMe), 'a non-dump file was deleted').toBe(true)
  })

  it('is quiet when the directory does not exist', () => {
    // It runs at startup, before anything has crashed, on a machine where
    // Crashpad may never have written. It must not throw into app launch.
    expect(purgeOldDumps(join(dir, 'nope'), DUMP_RETENTION_DAYS, NOW)).toEqual({
      deleted: 0,
      kept: 0,
      failed: 0
    })
  })

  it('the window is 14 days', () => {
    expect(DUMP_RETENTION_DAYS).toBe(14)
  })
})

describe('the two questions stay answered in the source', () => {
  const INDEX = readFileSync(join(__dirname, '..', '..', 'index.ts'), 'utf8')

  /** index.ts with comments blanked, line numbers preserved.
   *
   *  Needed because the first version of the uploadToServer check went red on
   *  the WARNING that forbids it: the comment reads "DO NOT SET
   *  uploadToServer: true", and a guard searching for that string found the
   *  prohibition rather than a violation. The same shape as the locality
   *  guard, which read a wrapped comment as user-facing copy. Anything that
   *  greps source for a forbidden string has to strip comments first, because
   *  the clearest codebases state the forbidden thing in prose right next to
   *  the code that avoids it. */
  const INDEX_CODE = INDEX.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('THE EGRESS LINE IS STILL THERE, and still false', () => {
    // There was no guard on this at all, and it is the line the M29 audit
    // called the highest-consequence in the codebase.
    //
    // It needs one because it was DELETED BY ACCIDENT on 2026-09-08, by a
    // scripted edit that meant to append the retention call after it and
    // replaced the block instead. Typecheck caught it — only because
    // `crashReporter` then became an unused import, which is luck rather than
    // coverage. If the import had still been used anywhere else, a build with
    // no crash reporting at all would have gone green.
    expect(
      INDEX,
      'crashReporter.start is gone — the app is no longer capturing native crashes at all'
    ).toContain('crashReporter.start({ uploadToServer: false, compress: true })')
    expect(
      INDEX_CODE,
      'uploadToServer is true somewhere — a minidump is raw process memory and this is the single ' +
        'largest content-egress path in the product'
    ).not.toMatch(/uploadToServer:\s*true/)
    expect(INDEX_CODE, 'a submitURL appeared beside the crash reporter').not.toMatch(/submitURL/)
  })

  it('the retention runs UNCONDITIONALLY, not inside the telemetry consent path', () => {
    // The trap this pins. `checkNativeCrashes` is only reached through
    // `recordLaunch`, which returns early unless consent is 'on'. Putting the
    // purge there would mean the users who opted OUT of telemetry are exactly
    // the users whose dumps are kept forever — retention is a property of the
    // data, not of a diagnostics preference.
    expect(INDEX, 'the dump purge is not called from index.ts').toContain(
      'purgeOldDumps(app.getPath('
    )
    const setup = readFileSync(join(__dirname, '..', 'setup.ts'), 'utf8')
    expect(
      setup,
      'the purge moved into telemetry/setup.ts, which returns early when consent is off — ' +
        'that would keep dumps forever for everyone who opted out'
    ).not.toContain('purgeOldDumps')
  })
})
