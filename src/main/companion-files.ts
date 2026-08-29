import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * BUG-139 — companion files that outlive the record they belong to.
 *
 * The bug: `deleteCall` states its guarantee in as many words — *"a deleted
 * call must not retain buyer words"* — and it already chases one companion
 * ("the review queue stages verbatim buyer quotes mined from this call —
 * deleting the call must take them with it, or [the] guarantee would be false
 * one folder over"). It just didn't know about the others. The backup
 * reconcile writes `<id>.conflict` beside a record, and that file holds the
 * FULL pre-deletion copy — transcript, summary, contact link. Deleting the
 * record tombstones the `.json` and leaves the `.conflict` untouched.
 *
 * Found for real: 4 deleted records on the founder's machine still had their
 * pre-deletion content sitting in a `.conflict` beside the scrubbed record,
 * two of them holding verbatim spoken dialogue from calls deleted 16 days
 * earlier.
 *
 * WHY THIS IS A MODULE AND NOT THREE UNLINK CALLS.
 * The founder's framing was the useful one: if deletion doesn't know about
 * `.conflict`, it may not know about `.tmp`, `.bak`, `.redacted`, or anything
 * else a write path produces. The failure is not any single extension, it is
 * that "what can exist beside a record" was knowledge with no home — spread
 * across whichever module happened to write each file. So it lives here, in
 * one list, and deletion consults the list rather than remembering.
 *
 * The rule for anyone adding a new companion: add its suffix to
 * RECORD_COMPANION_SUFFIXES below, in the same commit that writes it. The
 * guard test asserts this list covers every companion suffix actually written
 * under the record directories, so forgetting fails rather than leaks.
 */

/**
 * Suffixes a record directory (calls/, events/, tasks/, …) can contain
 * alongside `<id>.json`, all keyed by the SAME record id.
 *
 * `.conflict` — backup reconcile's losing copy (backup-core.ts). Holds a full
 *   record. This is the one BUG-139 was reported for.
 * `.tmp`      — atomic-write's staging file (atomic-write.ts). Normally renamed
 *   over the target within microseconds, but a crash or a force-quit between
 *   write and rename orphans one, and nothing has ever swept them. Found on
 *   the founder's machine: one orphan holding a complete copy of a live call.
 *   NOTE the real shape is `<id>.json.<uuid>.tmp`, so this is matched as a
 *   prefix+suffix pair, not a plain `<id>.tmp` — see companionPaths().
 */
export const RECORD_COMPANION_SUFFIXES = ['.conflict'] as const

/** Directories whose contents are `<id>.json` records with companions. */
export const RECORD_DIR_NAMES = ['calls', 'events', 'tasks', 'contacts', 'deals'] as const

/**
 * Every companion path that could exist for `id` in `dir`.
 *
 * Returns paths whether or not they exist — callers unlink best-effort. The
 * `.tmp` case is resolved by listing, because atomic-write names its staging
 * file `<id>.json.<uuid>.tmp` and the uuid is not knowable from the id.
 */
export async function companionPaths(dir: string, id: string): Promise<string[]> {
  const paths = RECORD_COMPANION_SUFFIXES.map((suffix) => join(dir, `${id}${suffix}`))

  // Orphaned atomic-write staging files for this record.
  try {
    const entries = await fs.readdir(dir)
    for (const name of entries) {
      if (name.startsWith(`${id}.json.`) && name.endsWith('.tmp')) paths.push(join(dir, name))
    }
  } catch {
    /* directory unreadable — the named companions above are still worth trying */
  }

  return paths
}

/**
 * Remove every companion file for a record. Best-effort per file, on purpose:
 * a locked or already-missing companion must never fail the deletion that
 * called this, or a user pressing delete would see an error and reasonably
 * conclude nothing was deleted — when in fact the record itself is gone.
 *
 * Returns how many files were actually removed, so callers can log it and the
 * tests can assert on something other than "it didn't throw".
 */
export async function purgeCompanionFiles(dir: string, id: string): Promise<number> {
  let removed = 0
  for (const path of await companionPaths(dir, id)) {
    try {
      await fs.unlink(path)
      removed++
    } catch {
      /* missing (the normal case) or locked — neither is worth failing for */
    }
  }
  return removed
}

/**
 * Is this record gone as far as a user is concerned — absent, tombstoned, or
 * unparseable-and-therefore-not-displayable?
 *
 * Reads the file directly rather than going through calls-fs/events-fs, so the
 * startup sweep does not have to import a record module (and its IPC, locks
 * and backup scheduling) just to answer a yes/no question about a file.
 *
 * Returns FALSE on any read it cannot interpret — the conservative direction.
 * A record this cannot parse must be treated as still present, so its
 * companions are left alone rather than swept on the strength of a bad read.
 */
export async function recordIsGone(dir: string, id: string): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(join(dir, `${id}.json`), 'utf8')
  } catch {
    return true // no file at all
  }
  try {
    return (JSON.parse(raw) as { deleted?: boolean }).deleted === true
  } catch {
    return false // unreadable — assume present, touch nothing
  }
}

/**
 * Startup sweep: companions whose record is gone or tombstoned.
 *
 * Needed as well as the delete-path fix, not instead of it. Every record
 * deleted BEFORE this shipped still has its companions on disk, and no future
 * deletion will ever revisit them — the record is already a tombstone, so
 * `deleteCall` returns early and never reaches the purge. Without this sweep
 * the fix only protects records deleted from now on, which is the smaller
 * half of the problem.
 *
 * Deliberately conservative: a companion beside a LIVE record is left alone.
 * A `.conflict` next to a live record may be a genuine two-device conflict and
 * is the user's to resolve; that is the case the whole mechanism exists for.
 */
export async function sweepOrphanedCompanions(baseDir: string): Promise<number> {
  let removed = 0

  for (const dirName of RECORD_DIR_NAMES) {
    const dir = join(baseDir, dirName)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue // directory doesn't exist on this install
    }

    // Which ids in this directory are gone or tombstoned?
    const purgeable = new Set<string>()
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      try {
        const raw = await fs.readFile(join(dir, name), 'utf8')
        if ((JSON.parse(raw) as { deleted?: boolean }).deleted === true) purgeable.add(id)
      } catch {
        /* unreadable record — leave it and its companions entirely alone */
      }
    }

    for (const name of entries) {
      const isCompanion =
        RECORD_COMPANION_SUFFIXES.some((s) => name.endsWith(s)) ||
        (name.includes('.json.') && name.endsWith('.tmp'))
      if (!isCompanion) continue

      // `<id>.conflict` -> id; `<id>.json.<uuid>.tmp` -> id
      const id = name.includes('.json.') ? name.slice(0, name.indexOf('.json.')) : name.slice(0, name.lastIndexOf('.'))

      const recordExists = entries.includes(`${id}.json`)
      // An orphaned .tmp is always safe to remove: it is by definition a
      // staging file whose rename never completed, so the live record either
      // never got it or already has it.
      const isStagingFile = name.endsWith('.tmp')

      if (!recordExists || purgeable.has(id) || isStagingFile) {
        try {
          await fs.unlink(join(dir, name))
          removed++
        } catch {
          /* best-effort */
        }
      }
    }
  }

  return removed
}
