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

/**
 * The inverse: express a SERVER timestamp on this device's clock.
 *
 * The rule this file follows is "local records are always device time, cloud
 * rows are always server time, and every boundary converts exactly once". This
 * is the import side of that. It matters because the store importers re-check
 * `payload.updatedAt` against the on-disk `updatedAt` themselves (their
 * onlyIfNewer guard) using plain device-vs-device comparison — so a payload
 * still carrying server time (or another device's raw clock) would let that
 * un-corrected re-check silently veto the skew-corrected decision made here.
 */
export const toDeviceIso = (serverIso: string | undefined | null, skewMs: number): string =>
  new Date(ts(serverIso) + skewMs).toISOString()

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
 * BUG-138 — is there actually anything to preserve?
 *
 * "Both sides changed since the last sync" was the ONLY test before, and it is
 * a statement about TIMESTAMPS, not about content. Two devices that saved the
 * same record without changing it — or one device whose lastSyncAt never
 * advanced because the app was killed mid-sync — satisfy it perfectly while
 * the two versions are byte-identical. Found on the founder's own machine:
 * 201 `.conflict` files, every single one identical to the record it sat
 * beside. Not one was a real conflict.
 *
 * That is worse than clutter. The Backup card counts these and warns "N
 * conflicting copies kept"; at 201 false positives, a genuine conflict — the
 * one case where a user must look — is invisible in the noise. A warning that
 * cries wolf is not a safety feature.
 *
 * `updatedAt` is excluded from the comparison deliberately: it is the one
 * field guaranteed to differ (the cloud copy was just re-stamped onto this
 * device's clock a few lines above), so including it would make every
 * comparison unequal and restore the original bug.
 */
/**
 * BUG-187 — WOULD KEEPING THE CLOUD VERSION DISCARD SOMETHING THE LOCAL COPY
 * HAS? That is the question a conflict copy exists to answer, and it is not the
 * question the previous predicate asked.
 *
 * `differsIgnoringTimestamp` compared the local record against the UPLOADED
 * PROJECTION, so it asked *"did the projection change?"*. The projection is not
 * the record and was never meant to be: `callBackupPayload` emits
 * `dealId: call.dealId ?? null` for a key the record omits, hard-blanks
 * `preview` and `segments` to keep the transcript off the wire, and carries
 * none of the KEEP_LOCAL fields at all. Measured on the founder's store by
 * `scripts/verification/conflict-guard-reach.ts`: it returned true for
 * **196 of 196** reachable call records, in both sync scopes. It never once
 * prevented a conflict copy.
 *
 * AND IT COULD NOT BE REPAIRED BY FIXING THOSE NORMALISATIONS. Leave-one-out
 * over the same 196: neutralising ANY SINGLE differing key silences **0**
 * records in the default scope (and `dealId` alone silences 74 of 196 in the
 * transcripts scope, which would have made a single-key fix look like it
 * worked). The causes are over-determined by four families, three of which are
 * things the payload is SUPPOSED to differ by. The right-hand side was wrong in
 * principle, not in detail.
 *
 * So this asks the real question, against what the importer actually WROTE:
 *
 *   - iterate the keys the LOCAL record has. A key present in `written` but not
 *     in `local` is an ADDITION — the cloud brought something new — never a loss.
 *   - `updatedAt` is excluded for the original reason: the written record
 *     carries the re-stamped value, so including it makes everything differ.
 *   - per-key comparison, so property ORDER cannot manufacture a difference.
 *     The sorted-keys trick the old predicate needed is unnecessary here.
 *
 * It is also correct for the stores whose `locals` map holds a PROJECTION
 * rather than a record — `assistant-conversations` maps to `{ id, updatedAt }`
 * — where the old predicate compared an id against a whole conversation and was
 * therefore structurally always true. That store has zero conflict files, which
 * was read as evidence FOR the old model rather than against it (species 106).
 */
/** Nothing to lose: absent, null, an empty string, an empty list or an empty
 *  object. NOT `0` and NOT `false`, which are real values a user can have set. */
function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  return false
}

function importWouldDiscard(local: unknown, written: unknown): boolean {
  if (!local || typeof local !== 'object' || !written || typeof written !== 'object') {
    return JSON.stringify(local ?? null) !== JSON.stringify(written ?? null)
  }
  const l = local as Record<string, unknown>
  const w = written as Record<string, unknown>
  for (const key of Object.keys(l)) {
    if (key === 'updatedAt') continue
    // YOU CANNOT LOSE WHAT YOU DID NOT HAVE. Found by driving the fix over the
    // founder's own records rather than by reasoning: 1 of 60 still
    // manufactured a conflict, on the one call with no local transcript. The
    // cloud brought one, `preview` went from '' to real text, and a
    // difference-based test called that a loss. It is a gain — and a guard
    // that conflicts on gains would put a file beside every record that ever
    // receives something new.
    if (isEmptyValue(l[key])) continue
    if (JSON.stringify(l[key]) !== JSON.stringify(w[key])) return true
  }
  return false
}

/** Remove a conflict copy written pre-emptively and then found unnecessary.
 *  Best-effort: a leftover identical copy is clutter, and clutter is the side
 *  this path errs toward deliberately — see the ordering note in reconcileStore. */
async function removeConflictCopy(dir: string, id: string): Promise<void> {
  try {
    await fs.unlink(join(dir, `${id}.conflict`))
  } catch {
    /* never existed, or could not be removed — neither is worth failing a restore */
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
    // Re-express the incoming record on THIS device's clock before it goes any
    // further. The payload was stamped by whichever device pushed it, so it is
    // a foreign (and possibly badly wrong) clock; the row's server_updated_at is
    // the authoritative instant. Converting here means the importers' own
    // onlyIfNewer re-check — which compares payload.updatedAt against the
    // on-disk updatedAt as plain device times — agrees with the skew-corrected
    // verdict below instead of overruling it.
    payload.updatedAt = toDeviceIso(row.server_updated_at, skewMs)
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
    const timestampsSayBothMoved =
      Boolean(lastSyncAt) && ts(local.updatedAt) > ts(lastSyncAt as string) && local.deleted !== true

    // PRESERVE FIRST, DECIDE AFTER — and the order is the safety property.
    //
    // Whether a conflict copy is NEEDED can only be answered by what the
    // importer actually writes, and finding that out means importing, which
    // replaces the local record. Deciding afterwards would leave a window
    // where a crash between the import and the copy loses the local version
    // outright. Writing first inverts the failure: a crash in that window
    // leaves an extra identical `.conflict` file, which is clutter.
    //
    // That is the founder's own rule, from downloadSalesBrainDb's decision
    // table: "when the choice is 'might lose data' vs 'might leave clutter',
    // clutter wins."
    if (timestampsSayBothMoved) await writeConflictCopy(dir, local.id, local)

    const written = await importRecord(dir, payload)
    if (written) changed++

    // BUG-187 — the real question, asked against what was WRITTEN rather than
    // against what was uploaded. If nothing was written, or the written record
    // still carries everything the local copy had, there was no conflict to
    // preserve and the pre-emptive copy comes back off.
    if (timestampsSayBothMoved && (!written || !importWouldDiscard(local, written))) {
      await removeConflictCopy(dir, local.id)
    }
  }
  return changed
}
