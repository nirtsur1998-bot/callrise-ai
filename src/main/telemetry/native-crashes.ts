// M29 A1.2 — counting native crashes without ever shipping a minidump.
//
// Electron's crashReporter (started with uploadToServer: false in index.ts)
// writes a minidump to app.getPath('crashDumps') when the process dies hard —
// the kind of death no JavaScript handler sees. A minidump is a snapshot of
// PROCESS MEMORY: it can contain a live transcript, a memory, a key. It stays
// on the machine, always. What telemetry gets is a NUMBER: how many new dumps
// appeared since the last launch. That is enough to know a version is
// crashing natively (the Sales Brain / onnxruntime class of failure) without
// seeing a byte of what was in memory.
//
// Pure-ish: directory and marker path are injected; no Electron import.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export const NATIVE_CRASH_MARKER = 'telemetry-native-crash-marker.json'

/** How long a minidump is kept. Founder's decision, 2026-09-08.
 *
 *  Fourteen days is long enough that a crash reported by a user this week can
 *  still be read on the machine that produced it, and short enough that a
 *  snapshot of process memory containing a live transcript is not sitting on
 *  disk a year later because nobody wrote the second half of the policy. */
export const DUMP_RETENTION_DAYS = 14

interface Marker {
  /** mtime (ms) of the newest dump seen at the last check. */
  lastSeenMtimeMs: number
}

const DUMP_EXT = /\.dmp$/i

/** Every minidump under `dir` (Crashpad nests them in reports/, pending/, completed/). */
function listDumps(dir: string, depth = 0): Array<{ path: string; mtimeMs: number }> {
  const out: Array<{ path: string; mtimeMs: number }> = []
  if (depth > 3 || !existsSync(dir)) return out
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isDirectory()) out.push(...listDumps(p, depth + 1))
      else if (DUMP_EXT.test(name)) out.push({ path: p, mtimeMs: st.mtimeMs })
    } catch {
      /* a vanished file is not a crash */
    }
  }
  return out
}

/**
 * Delete minidumps older than the retention window.
 *
 * WHY THIS EXISTS. The crash reporter was set up with a long, correct and
 * emphatic warning about EGRESS — do not set uploadToServer, a dump is raw
 * process memory holding live transcript text, buyer speech, contact and deal
 * records and any AI key in use — and it concluded "the dumps are kept locally
 * on purpose". The retention question was never asked beside it. Nothing in
 * the product had ever deleted one: no age cap, no size cap, no sweep. The
 * only code that touched them counted them.
 *
 * So `deleteCall`'s promise that a deleted call retains no buyer words was
 * false for any call during which the app died hard, and stayed false forever,
 * under a filename no assertion could have been written for.
 *
 * IT MUST NOT BE GATED ON TELEMETRY CONSENT, and that is the one thing most
 * likely to be got wrong here. `checkNativeCrashes` is only reached through
 * `recordLaunch`, which returns early unless consent is 'on' — so putting the
 * purge there would mean the users who opted OUT of telemetry are exactly the
 * users whose crash dumps are kept forever. Retention is a property of the
 * data, not of a diagnostics preference. This runs unconditionally at startup.
 *
 * One interaction, stated rather than discovered later: a dump older than the
 * window is deleted even if the crash count has not been reported. That can
 * only happen when the app has not launched inside the window, so what is lost
 * is a fortnight-old crash statistic, not a crash the user is still hitting.
 *
 * Never throws: a dump we cannot delete must not stop the app starting.
 */
export function purgeOldDumps(
  crashDumpsDir: string,
  maxAgeDays: number = DUMP_RETENTION_DAYS,
  now: number = Date.now()
): { deleted: number; kept: number; failed: number } {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000
  let deleted = 0
  let kept = 0
  let failed = 0
  for (const dump of listDumps(crashDumpsDir)) {
    if (dump.mtimeMs >= cutoff) {
      kept++
      continue
    }
    try {
      rmSync(dump.path, { force: true })
      deleted++
    } catch {
      failed++
    }
  }
  return { deleted, kept, failed }
}

function readMarker(markerPath: string): Marker {
  try {
    if (!existsSync(markerPath)) return { lastSeenMtimeMs: 0 }
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf8'))
    const v = (parsed as { lastSeenMtimeMs?: unknown }).lastSeenMtimeMs
    return { lastSeenMtimeMs: typeof v === 'number' && Number.isFinite(v) ? v : 0 }
  } catch {
    return { lastSeenMtimeMs: 0 }
  }
}

export interface NativeCrashCheck {
  /** Dumps newer than the marker — i.e. crashes since the last launch. */
  newDumps: number
  /** Whether this is the first check ever (no marker): then nothing is "new", just baselined. */
  baselined: boolean
}

/**
 * Count dumps that appeared since the last check and advance the marker.
 * On the very first run there is no marker, so existing dumps are baselined
 * rather than reported — they predate consent. Never throws.
 */
export function checkNativeCrashes(crashDumpsDir: string, markerPath: string): NativeCrashCheck {
  try {
    const hadMarker = existsSync(markerPath)
    const marker = readMarker(markerPath)
    const dumps = listDumps(crashDumpsDir)
    const newest = dumps.reduce((m, d) => Math.max(m, d.mtimeMs), marker.lastSeenMtimeMs)
    const newDumps = hadMarker ? dumps.filter((d) => d.mtimeMs > marker.lastSeenMtimeMs).length : 0
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, JSON.stringify({ lastSeenMtimeMs: newest }), 'utf8')
    return { newDumps, baselined: !hadMarker }
  } catch {
    return { newDumps: 0, baselined: false }
  }
}
