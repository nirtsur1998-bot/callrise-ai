// BUG-168 — `--diagnose` printed NOTHING, exit 0, whenever the app was
// already running. Which is the normal state when someone is asked to run it.
//
// The single-instance lock is requested at module load, long before
// `app.whenReady()`. A second process loses it, calls app.quit(), `ready`
// never fires, and the diagnose branch inside the whenReady handler is never
// reached. Empty stdout with a zero exit code reads as "it worked and found
// nothing" — the worst possible failure for a diagnostic.
//
// This is a SOURCE-LEVEL assertion, and says so. index.ts is the Electron
// entry point: importing it in a test would run the whole registration
// sequence. The invariant being pinned is an ORDERING one — that the lock is
// never requested for a diagnose run — and ordering at module scope is
// exactly what a source assertion can hold onto. The behavioural proof is a
// driven one: with the app running, `electron out/main/index.js --diagnose`
// printed nothing before this change and a full report after.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

describe('BUG-168 — a diagnose run must not take the single-instance lock', () => {
  it('consults wantsDiagnose() before requesting the lock', () => {
    const line = SRC.split('\n').find((l) => l.includes('requestSingleInstanceLock()'))
    expect(line, 'no requestSingleInstanceLock() call found at all').toBeDefined()
    // Short-circuit order matters: wantsDiagnose() must come FIRST, or the
    // lock is still requested and the losing instance still quits.
    const idxDiagnose = line!.indexOf('wantsDiagnose()')
    const idxLock = line!.indexOf('requestSingleInstanceLock()')
    expect(idxDiagnose, 'wantsDiagnose() is not on the lock line').toBeGreaterThan(-1)
    expect(idxDiagnose).toBeLessThan(idxLock)
    expect(line).toContain('||')
  })

  it('still requests the lock for an ordinary launch', () => {
    expect(SRC).toContain('app.requestSingleInstanceLock()')
  })

  // The bug was only reachable because the diagnose branch lives inside the
  // whenReady handler. If that ever moves ABOVE the lock, this guard becomes
  // unnecessary — and this test should be revisited rather than silently kept.
  it('the diagnose branch is still inside whenReady, which is why this matters', () => {
    const lockAt = SRC.indexOf('requestSingleInstanceLock()')
    const readyAt = SRC.indexOf('app.whenReady()')
    const diagnoseAt = SRC.indexOf('if (wantsDiagnose())')
    expect(lockAt).toBeGreaterThan(-1)
    expect(readyAt).toBeGreaterThan(lockAt)
    expect(diagnoseAt).toBeGreaterThan(readyAt)
  })
})
