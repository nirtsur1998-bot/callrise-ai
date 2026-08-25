# Sales Brain backup stopgap — manual, works today

**Why this exists:** BUG-087 (the `sales-brain` bucket was never created) plus
the planned Supabase migration means memory.db has **no cloud copy until the
cutover**. This is the ten-minute manual bridge.

**Live evidence that shaped these instructions (2026-08-24, the founder's own
machine):** `memory.db` itself was last written **Aug 14**, while
`memory.db-wal` (3 MB) was written **today** — nine days of memories were
sitting in the write-ahead log, not yet folded into the main file. So:

> **Copying `memory.db` alone can silently lose days of memories. Copy all
> three files, with the app fully quit.**

---

## The backup (do this weekly, and after any important call day)

1. **Quit CallRise completely** — main window closed AND no tray icon left
   running. (A quit checkpoints nothing by itself, but it stops new writes;
   copying the trio below is then always consistent.)
2. Open this folder (paste into Explorer's address bar):
   ```
   %APPDATA%\sales-os
   ```
3. Copy these files — **all that exist of the three**:
   - `memory.db`
   - `memory.db-wal`  ← the part that held 9 days of data today
   - `memory.db-shm`
4. Put the copies in a dated folder (e.g. `SalesBrain-2026-08-24`) and drop
   that folder in Drive/Dropbox/a USB stick.

**Do NOT** point Drive/Dropbox live-sync at the `sales-os` folder itself —
the app writes to these files constantly while running, and a sync client
snapshotting mid-write uploads a torn database. Copy first, then store the
copy.

Bonus existing snapshot: `memory.db.pre-migration-backup` (Aug 15) is a
schema-migration safety copy the app made itself — older, but real; worth
including in your first backup folder.

## The restore (a new machine, or after a disk failure)

1. Install CallRise, **run it once, quit it completely** (this creates
   `%APPDATA%\sales-os`).
2. In `%APPDATA%\sales-os`, delete any `memory.db`, `memory.db-wal`,
   `memory.db-shm` that exist (a fresh install's empty ones).
3. Copy your backed-up trio in.
4. Start CallRise → Settings → Sales Brain → Memory Center: your memories
   are the proof. (SQLite folds the `-wal` back into the main file on first
   open — nothing else to do.)

The app's own restore-from-cloud deliberately never overwrites an existing
local `memory.db`, so a manual restore can't be clobbered by a later sync.

## The button, if you want one (next session, ~30 lines)

better-sqlite3 has an online-backup API (`db.backup(path)`) that produces a
consistent single-file snapshot **while the app runs** — no quit, no
sidecars, no WAL trap. An "Export Sales Brain…" button in Settings → Sales
Brain writing `SalesBrain-<date>.db` to a folder you pick is a natural A5
sibling. Say the word and it goes in the A5 batch.

## Found while writing this: BUG-088

The cloud upload code (`backup.ts` → `fs.readFile(memory.db)`) is
**WAL-blind**: it reads only the main file, so even after the migration
creates the bucket, the nightly upload would have shipped a copy that was
days stale (today it would have uploaded the Aug 14 state and missed
everything since). Logged as its own bug; the fix (use the online-backup API
or checkpoint before upload) rides with the migration/A5 work — it must land
**before** the new project's upload is trusted.
