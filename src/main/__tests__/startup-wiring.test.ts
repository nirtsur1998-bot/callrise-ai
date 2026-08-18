// M27 re-audit, row 9 — the WIRE between a well-tested unit and the event
// that actually triggers it in production.
//
// sales-brain-startup.test.ts covers scheduleSalesBrainStartup thoroughly, by
// calling the `windowReady` callback it returns. Production does not call
// that callback: Electron fires the window's 'ready-to-show' event, and
// index.ts's handler invokes it. Nothing in the suite imports index.ts, so
// that connection had NO coverage of any kind — delete the invocation and
// every test still passes (taxonomy species 21).
//
// ── WHAT THIS TEST IS, AND HONESTLY IS NOT ──────────────────────────────
//
// It is a SOURCE-LEVEL assertion. It reads index.ts as text and checks the
// three statements that form the wire are present. It cannot execute them:
// index.ts calls app.whenReady() at module load and reaches into Electron
// throughout, so importing it in vitest is not possible without a rewrite
// far larger than the risk justifies.
//
// So be clear about its power:
//   CATCHES  — the wire being deleted, or renamed apart, in any of the three
//              places it has to agree.
//   MISSES   — the wire being present but wrong (invoked at the wrong moment,
//              on the wrong event, or after something that throws first).
//
// A text assertion is a weak instrument and it would be dishonest to file it
// as coverage of the behaviour. It is coverage of the CONNECTION, which is
// the specific thing that was at zero.
//
// ── AND THE SEVERITY, STATED CORRECTLY ──────────────────────────────────
//
// The first write-up of this finding claimed a cut wire meant Sales Brain
// never initialised. That was wrong, and the correction matters more than the
// finding: scheduleSalesBrainStartup arms a READY_FALLBACK_MS timer (10s)
// that calls begin() regardless. A cut wire degrades to a ~10 second delay,
// not an absent feature. The severe reading came from tracing the call chain
// without checking whether anything outside it absorbed the failure —
// backstops live outside the chain, which is exactly why "trace the wire" is
// only half a diagnostic.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Source with `//` comment lines removed.
 *
 *  LEARNED THE HARD WAY, in this file's own red check: commenting the wire
 *  out left every assertion passing, because a text match cannot tell live
 *  code from a comment containing the same text. The first version of this
 *  test would have reported a cut wire as intact — the exact failure it was
 *  written to catch, in the instrument written to catch it. */
function liveCode(text: string): string {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const indexSrc = liveCode(readFileSync(join(__dirname, '..', 'index.ts'), 'utf8'))

describe('the ready-to-show wire into Sales Brain startup', () => {
  it('declares the holder the window handler and the scheduler both use', () => {
    expect(indexSrc).toMatch(/let onWindowShown: \(\(\) => void\) \| null = null/)
  })

  it('assigns scheduleSalesBrainStartup(...).windowReady to it', () => {
    // The scheduler's trigger has to be stored somewhere the window handler
    // can reach. If this assignment goes, init only ever happens on the
    // fallback timer.
    expect(indexSrc).toMatch(/onWindowShown = scheduleSalesBrainStartup\(/)
    expect(indexSrc).toMatch(/\}\)\.windowReady/)
  })

  it("invokes it from the window's ready-to-show handler, after show()", () => {
    // The whole point of the ordering: init must not begin until the window
    // is actually painted, because openMemoryDb blocks the main process
    // synchronously and a blocked main process cannot deliver ready-to-show.
    const handler = indexSrc.slice(
      indexSrc.indexOf("mainWindow.on('ready-to-show'"),
      indexSrc.indexOf("mainWindow.webContents.setWindowOpenHandler")
    )
    expect(handler).toContain('mainWindow?.show()')
    expect(handler).toMatch(/const notify = onWindowShown/)
    expect(handler).toMatch(/notify\?\.\(\)/)

    // show() must come FIRST. If init were kicked off before the window is
    // shown, its synchronous DB open would block the paint it is waiting for.
    expect(handler.indexOf('mainWindow?.show()')).toBeLessThan(handler.indexOf('notify?.()'))
  })

  it('clears the holder when firing, so a later window cannot re-trigger init', () => {
    // createWindow() is also reachable from the 'activate' handler on a
    // relaunch, long after startup. Firing init a second time would run a
    // migration against a database that is already open.
    const handler = indexSrc.slice(
      indexSrc.indexOf("mainWindow.on('ready-to-show'"),
      indexSrc.indexOf("mainWindow.webContents.setWindowOpenHandler")
    )
    expect(handler).toMatch(/onWindowShown = null/)
  })
})

describe('the fallback that bounds a cut wire', () => {
  it('still exists, because it is what makes a broken wire survivable', () => {
    // This is the backstop that turns "Sales Brain never starts" into "Sales
    // Brain starts ~10s late". The tests above guard the wire; this guards
    // the thing that makes the wire non-critical. Losing both silently is
    // the only combination that actually costs a user the feature.
    const startupSrc = liveCode(
      readFileSync(join(__dirname, '..', 'memory', 'sales-brain-startup.ts'), 'utf8')
    )
    expect(startupSrc).toMatch(/setTimer\(begin, fallbackMs\)/)
    expect(startupSrc).toMatch(/READY_FALLBACK_MS = 10_000/)
  })
})
