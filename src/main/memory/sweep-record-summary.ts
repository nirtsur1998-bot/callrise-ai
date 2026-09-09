// The BUG-215 quote sweep's record, projected for OUTBOUND use.
//
// WHY THIS EXISTS. The M37 ramp criterion is `rescuedByFileCheck` — calls the
// bulk listing believed were gone and the filesystem found alive. Zero on a
// healthy machine; anything above zero means that machine's calls-directory
// read is unreliable and quotes were one check away from being destroyed.
//
// It was recorded honestly and reached nobody. The founder, 2026-09-09:
// "a criterion nobody can observe isn't a criterion... that's not a gate, it's
// a hope." So it goes into the support bundle and --diagnose, and this module
// is the gate it passes through on the way.
//
// ── A WHITELIST, NOT A PASS-THROUGH, AND THAT IS THE WHOLE POINT ────────────
//
// Every field the record holds TODAY is a status literal, an ISO timestamp,
// one of two fixed reason literals, or an integer. Nothing is derived from
// memory content. So it would be safe to emit verbatim — today.
//
// It is not emitted verbatim, for three reasons, each of which is a real
// property of this code rather than caution for its own sake:
//
//  1. The record is read as an UNCHECKED CAST (`JSON.parse(raw) as
//     QuoteSweepRecord`, memory-runtime.ts). Whatever is in that row comes
//     back, typed as if it were the interface. A record written by a future
//     version, or hand-edited, carries its extra keys straight through.
//  2. `reason` is safe as one of two known literals and unsafe as a field.
//     The sibling record twenty lines away in the same file interpolates
//     filesystem error messages into its own reason. One future edit in that
//     direction turns a pass-through into a leak.
//  3. The neighbouring `temporal_backfill` row in the same table CAN carry an
//     absolute path and a call id. Anything scoped to "the meta table" rather
//     than to this key would take it along.
//
// So: nine known keys, each type-checked, `reason` accepted only on an exact
// match of the two literals the code can actually produce, and everything else
// dropped. A key this module has never heard of cannot reach a bundle.
//
// Pure and electron-free on purpose, so the support bundle and the test suite
// can both use it without a running app.

/** The only keys that may ever leave the machine from this record. */
export const SWEEP_SUMMARY_KEYS = [
  'status',
  'at',
  'reason',
  'callsSwept',
  'memoriesTouched',
  'quotesRedacted',
  'charactersRemoved',
  'memoriesTotal',
  'rescuedByFileCheck'
] as const

/** The two `reason` strings the code can produce. Anything else is dropped and
 *  reported as unrecognised rather than emitted — see reason 2 above. */
export const KNOWN_SKIP_REASONS = [
  'connection replaced during startup',
  'calls directory read as empty while memories exist — refusing to sweep'
] as const

const NUMERIC_KEYS = [
  'callsSwept',
  'memoriesTouched',
  'quotesRedacted',
  'charactersRemoved',
  'memoriesTotal',
  'rescuedByFileCheck'
] as const

export interface SweepSummary {
  status: 'ran' | 'skipped'
  at?: string
  reason?: string
  callsSwept?: number
  memoriesTouched?: number
  quotesRedacted?: number
  charactersRemoved?: number
  memoriesTotal?: number
  rescuedByFileCheck?: number
  /** Set when the stored record carried keys this module does not know. The
   *  COUNT is emitted, never the names or values — a key name invented by a
   *  future version is itself content we have not vetted. */
  unknownKeysDropped?: number
}

/** ISO-8601 as `new Date().toISOString()` produces it, and nothing else. A
 *  timestamp is the one field with a shape worth checking: it is the only
 *  string that passes through, so it is the only string that could be made to
 *  carry something. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Project a stored sweep record down to what may leave the machine.
 * Returns null when there is no usable record at all. Never throws.
 */
export function projectSweepRecord(raw: unknown): SweepSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const src = raw as Record<string, unknown>

  const status = src['status']
  if (status !== 'ran' && status !== 'skipped') return null

  const out: SweepSummary = { status }

  if (typeof src['at'] === 'string' && ISO.test(src['at'])) out.at = src['at']

  const reason = src['reason']
  if (typeof reason === 'string') {
    out.reason = (KNOWN_SKIP_REASONS as readonly string[]).includes(reason)
      ? reason
      : '(unrecognised reason — not emitted)'
  }

  for (const key of NUMERIC_KEYS) {
    const v = src[key]
    // Integers only. NaN and Infinity are numbers; neither is a count.
    if (typeof v === 'number' && Number.isInteger(v)) out[key] = v
  }

  const known = new Set<string>(SWEEP_SUMMARY_KEYS)
  const dropped = Object.keys(src).filter((k) => !known.has(k)).length
  if (dropped > 0) out.unknownKeysDropped = dropped

  return out
}

/**
 * The four fields that quantify what the brain HELD, as opposed to what the
 * sweep DID.
 *
 * `forgetEverything` deliberately does not wipe memory_meta — it is app state,
 * not memory content — so the sweep's record OUTLIVES an erase. Without this, a
 * user who pressed "Forget EVERYTHING... This cannot be undone" and then sent a
 * support bundle would ship "43 quotes redacted, 2,537 characters removed, 73
 * memories total": no content, but a precise description of the size and shape
 * of what they had just erased.
 *
 * `callsSwept` and `rescuedByFileCheck` are KEPT, deliberately rather than by
 * oversight: together they are the ramp criterion, and dropping callsSwept
 * would make every post-erase machine report a TRIVIALLY ZERO indistinguishable
 * from a fresh install. The line drawn is "what the sweep did" stays, "how much
 * the user had" goes.
 */
const CONTENT_SCALE_KEYS = [
  'memoriesTouched',
  'quotesRedacted',
  'charactersRemoved',
  'memoriesTotal'
] as const

/** Apply when the Sales Brain is empty — see CONTENT_SCALE_KEYS. */
export function withoutErasedScale(s: SweepSummary | null): SweepSummary | null {
  if (!s) return null
  const out: SweepSummary = { ...s }
  for (const k of CONTENT_SCALE_KEYS) delete out[k]
  return out
}

/**
 * The sentence a support reader needs, so a non-zero reads as a problem rather
 * than as a statistic. The founder's condition, 2026-09-09.
 *
 * Deliberately says what a zero is worth too: a zero over an empty population
 * is not evidence of anything, and reporting it as reassurance is how a ramp
 * gets approved on nothing.
 */
export function explainSweepSummary(s: SweepSummary | null): string {
  if (!s) return 'No sweep record — the sweep has not completed on this machine.'
  if (s.status === 'skipped') {
    return (
      'The sweep was SKIPPED on the last attempt and will retry on the next launch. ' +
      'Deleted calls may still have quotes in the Sales Brain until it completes.'
    )
  }
  const rescued = s.rescuedByFileCheck
  const swept = s.callsSwept ?? 0
  if (typeof rescued !== 'number') {
    return (
      'This record predates the filesystem cross-check, so it carries no rescue count. ' +
      'Absent is not zero.'
    )
  }
  if (rescued > 0) {
    return (
      `PROBLEM: rescuedByFileCheck is ${rescued}. On this machine the call listing and the ` +
      'filesystem disagreed, and that many calls were about to have their quotes destroyed ' +
      'while the call still existed. The listing is unreliable here. This is worth reporting.'
    )
  }
  if (swept + rescued === 0) {
    return (
      'rescuedByFileCheck is 0, but the sweep examined nothing on this machine ' +
      '(callsSwept 0), so the check was never exercised. Not evidence either way.'
    )
  }
  return (
    `rescuedByFileCheck is 0 over ${swept + rescued} call(s) actually examined — the call ` +
    'listing and the filesystem agreed. This is the healthy result.'
  )
}

/**
 * Read the sweep record out of a profile, projected and erase-aware.
 *
 * ONE reader, used by both the support bundle and --diagnose. They had a copy
 * each for about an hour, which is exactly how two outbound surfaces drift
 * until one of them is the leak — the same shape as `engineDiagnosticFiles`,
 * whose comment records that sharing one list is what let one fix repair both.
 *
 * Its own read-only connection rather than the app's live handle, so a test can
 * point it at a real poisoned database. Never throws: every caller is a
 * diagnostic that has to work on the broken machine, which is the only kind
 * anyone runs it on.
 */
export function readSweepSummary(userDataDir: string): { summary: SweepSummary | null; meaning: string } {
  const path = `${userDataDir}/memory.db`
  let summary: SweepSummary | null = null
  let meaning = 'Sales Brain has not created a memory database on this machine.'
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    if (!existsSync(path)) return { summary, meaning }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3')
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try {
      // Scoped to the exact key. NEVER to memory_meta as a whole: the
      // neighbouring temporal_backfill row can carry an absolute path and a
      // call id in its own reason.
      const row = db
        .prepare('SELECT value FROM memory_meta WHERE key = ?')
        .get('bug215.quoteSweep') as { value?: string } | undefined
      summary = row?.value ? projectSweepRecord(JSON.parse(row.value)) : null
      // The brain being empty is what makes the population counts a
      // description of erased data rather than of a live store.
      const memories = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
      if (memories.n === 0) summary = withoutErasedScale(summary)
      meaning = explainSweepSummary(summary)
    } finally {
      db.close()
    }
  } catch {
    meaning = 'The memory database could not be read for this report.'
  }
  return { summary, meaning }
}
