// M29 FIX B / B5 — ONE scrubbed-copy helper, used by every export that ships
// a log file off the machine.
//
// WHY IT EXISTS. `docs/M29-A1-plan.md` claimed "every byte that leaves the
// machine — telemetry, support bundle, diagnostics zip — is built by the same
// buildOutbound() that runs the scrubber… There is no second path." That
// function never existed, and the claim was false: the M27 diagnostics zip
// copied `kern_bridge.log` with a raw `copyFileSync` and never imported the
// scrubber at all (BUG-094). The phantom name concealed the gap, because a
// reviewer greps `buildOutbound`, finds nothing, and assumes a rename.
//
// So this module is the thing that claim described. Two callers, one
// mechanism, no drift — the same rule A5.2 applied to snapshotMemoryDb.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { scrub } from './scrub'

/**
 * Copy `src` to `destPath` with EVERY LINE scrubbed.
 *
 * Line-by-line rather than whole-file: the app-wide `scrub` caps a single
 * string at 4096 chars, which is right for a log line and catastrophic for a
 * whole document (it silently truncates into unparseable output — the sweep
 * measured 29 of 47 jobs lost that way). A log is a sequence of lines, so the
 * per-line shape is both correct and cheap.
 *
 * Returns false rather than throwing on any failure. That is deliberate and
 * load-bearing for the diagnostics zip, whose loop documents "a locked or
 * unreadable log is skipped, never fatal — partial diagnostics still beat
 * none."
 */
export function scrubbedCopy(src: string, destPath: string): boolean {
  try {
    if (!existsSync(src)) return false
    const lines = readFileSync(src, 'utf8').split('\n')
    writeFileSync(destPath, lines.map((l) => scrub(l)).join('\n'), 'utf8')
    return true
  } catch {
    return false
  }
}
