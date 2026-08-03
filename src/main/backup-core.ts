// Pure, network-free core of the cloud-mirror RESTORE (M16). Deliberately kept
// separate from backup.ts — which needs Electron + Supabase and can't run under
// a plain Node test — so the reconcile logic is unit-provable in isolation.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** Parse an ISO-ish timestamp to ms; anything unparseable orders FIRST (0). */
export const ts = (s: string | undefined | null): number => {
  const t = s ? Date.parse(s) : NaN
  return Number.isNaN(t) ? 0 : t
}

/**
 * Convert a DEVICE-clock timestamp into SERVER-clock time.
 *
 * Local records are stamped with `new Date()` — this machine's clock. Cloud rows
 * carry `server_updated_at`, stamped by the DB. Comparing those two directly is
 * comparing two different clocks: on a device running 48h fast every local
 * record looks newer than anything the server has ever seen, so a genuinely
 * newer cloud copy would never win and restore would silently return stale data
 * (and 48h slow inverts it — the cloud always wins and real local edits get
 * spuriously conflicted).
 *
 * `skewMs` is (deviceNow - serverNow), measured against the server. Subtracting
 * it puts a device timestamp on the server's timeline so the two are comparable.
 * A skew we could not measure is passed as 0, which reproduces the old
 * behaviour exactly — never worse, and never a hard failure.
 */
export const toServerMs = (deviceIso: string | undefined | null, skewMs: number): number =>
  ts(deviceIso) - skewMs

/**
 * Same conversion, rendered back as an ISO string for UPLOAD.
 *
 * The pushed `updated_at` is what the DB trigger compares across devices
 * ("is the incoming row newer than the stored one?"). If each device uploads
 * its own raw clock, two devices with different skews compare unequal clocks
 * there too — a device running slow would have its genuinely-newer edits
 * rejected as stale. Uploading server-normalised time makes that comparison
 * like-for-like no matter how wrong either device's clock is.
 */
export const toServerIso = (deviceIso: string | undefined | null, skewMs: number): string =>
  new Date(toServerMs(deviceIso, skewMs)).toISOString()

/** One record as stored in a backup_* table. */
export interface CloudRow {
  id: string
  updated_at: string
  /** Authoritative, server-clock timestamp (set by the DB trigger) — used to
   *  decide "is the cloud version newer", never the device-supplied updated_at
   *  above, which could be wrong if that device's clock is wrong. */
  server_updated_at: string
  deleted: boolean
  payload: unknown
}

/** The losing side of a two-machine concurrent edit is kept beside the store as
 *  `<id>.conflict` — NOT `.json`, so directory listings never pick it up. */
async function writeConflictCopy(dir: string, id: string, record: unknown): Promise<void> {
  try {
    await fs.writeFile(join(dir, `${id}.conflict`), JSON.stringify(record, null, 2), 'utf8')
  } catch {
    /* best-effort — losing the conflict copy must not fail the restore */
  }
}

/**
 * Reconcile one store BY RECORD ID — never wipe, never blind-overwrite:
 *   cloud-only      → import it (id-preserving)
 *   local-only      → left alone here; the caller's push uploads it after
 *   in both         → keep whichever is newer (timestamps compared as ms)
 *   cloud tombstone → apply locally ONLY if the tombstone is newer
 * If a record changed on BOTH sides since `lastSyncAt` (edited on two machines
 * at once), the losing local version is kept as a `.conflict` copy.
 *
 * `importRecord` must be an ID-PRESERVING importer that re-runs the store's
 * sanitizer (NEVER the normal create path, which mints new ids and would
 * duplicate on every pull). Returns how many records changed.
 *
 * `skewMs` is this device's clock offset from the server (deviceNow-serverNow);
 * see toServerMs. Pass 0 when it could not be measured.
 */
export async function reconcileStore<
  T extends { id: string; updatedAt: string; deleted?: boolean }
>(
  dir: string,
  rows: CloudRow[],
  locals: Map<string, T>,
  importRecord: (dir: string, payload: unknown) => Promise<T | null>,
  lastSyncAt: string | undefined,
  skewMs = 0
): Promise<number> {
  let changed = 0
  for (const row of rows) {
    if (!row?.payload || typeof row.payload !== 'object') continue
    const payload = { ...(row.payload as Record<string, unknown>) }
    if (row.deleted) payload.deleted = true // older rows may predate the in-payload flag
    const local = locals.get(row.id)

    if (!local) {
      if (row.deleted) continue // never had it locally — nothing to delete
      if (await importRecord(dir, payload)) changed++
      continue
    }

    // Use the server's own clock (server_updated_at) to decide whether the
    // cloud copy is newer — never the pushing device's own updated_at, which a
    // device with a fast/wrong clock could have inflated. The local side is
    // converted ONTO the server's timeline first (toServerMs) so this is a
    // like-for-like comparison; comparing raw device time against server time
    // is what let a skewed clock pick the wrong winner.
    const cloudT = ts(row.server_updated_at)
    const localOnServerT = toServerMs(local.updatedAt, skewMs)
    if (cloudT <= localOnServerT) continue // local is same-or-newer → local wins; push uploads it

    // Cloud is newer → it wins. If the local copy was ALSO edited since our last
    // sync (a genuine two-machine concurrent edit), keep it as a .conflict copy.
    // Both sides here are THIS device's own clock (local.updatedAt and the
    // lastSyncAt we wrote ourselves), so they are already comparable — applying
    // the skew correction to only one of them would reintroduce the same bug.
    if (lastSyncAt && ts(local.updatedAt) > ts(lastSyncAt) && local.deleted !== true) {
      await writeConflictCopy(dir, local.id, local)
    }
    if (await importRecord(dir, payload)) changed++
  }
  return changed
}
