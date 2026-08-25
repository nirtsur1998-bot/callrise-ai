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

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const NATIVE_CRASH_MARKER = 'telemetry-native-crash-marker.json'

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
