// M37 Stage 1 — a verified snapshot of a memory.db, taken while the app may
// hold it open.
//
// WHY NOT `copy`: the app keeps memory.db open in WAL mode, so a plain file
// copy can catch the main file mid-checkpoint and miss what sits in the -wal.
// SQLite's own backup API, run from a READ-ONLY connection, produces a
// consistent single-file image regardless. That also means the snapshot's
// file bytes cannot equal the live file's bytes (one is a WAL database, the
// other a plain one), so "byte-verified" here means CONTENT-verified: every
// row of every table hashed in a fixed order on both sides, the two digests
// printed and compared, plus integrity_check on the snapshot. The founder's
// condition was "if the new extraction is worse, I want to go back" — a
// content-identical image satisfies that; a byte-identical file of a WAL db
// is not obtainable while the app runs.
//
// READ-ONLY on the source, always. Writes ONE new file at the destination.
//
//   node scripts/verification/memory-snapshot.mjs <source memory.db> <dest dir> [--label name]
//
// Prints: the snapshot path, both content digests, the row counts, and
// integrity_check. Exit 0 only when the digests match AND integrity is ok.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const [, , srcArg, destArg, ...rest] = process.argv
if (!srcArg || !destArg) {
  console.error('usage: node scripts/verification/memory-snapshot.mjs <source memory.db> <dest dir> [--label name]')
  process.exit(2)
}
const labelIdx = rest.indexOf('--label')
const label = labelIdx >= 0 ? rest[labelIdx + 1] : 'snapshot'
const src = resolve(srcArg)
const destDir = resolve(destArg)
if (!existsSync(src)) {
  console.error(`source does not exist: ${src}`)
  process.exit(2)
}
mkdirSync(destDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dest = join(destDir, `memory-${label}-${stamp}.db`)

/** Every user table, every row, in a fixed order, hashed. Schema included so a
 *  column added or dropped changes the digest too. */
function contentDigest(db) {
  const h = createHash('sha256')
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
  const counts = {}
  for (const t of tables) {
    // virtual tables (vec0, fts5) are rebuilt from their sources; hash their
    // declarations, not their shadow rows
    h.update(`TABLE ${t.name}\n${t.sql}\n`)
    if (/VIRTUAL TABLE/i.test(t.sql ?? '')) continue
    if (/^(memories_fts|memories_vec)_/.test(t.name)) continue // shadow tables of the virtual ones
    let rows
    try {
      rows = db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()
    } catch {
      rows = db.prepare(`SELECT * FROM "${t.name}"`).all()
    }
    counts[t.name] = rows.length
    for (const r of rows) h.update(JSON.stringify(r, Object.keys(r).sort()) + '\n')
  }
  return { digest: h.digest('hex'), counts }
}

const source = new Database(src, { readonly: true })
const before = contentDigest(source)
await source.backup(dest)
source.close()

const snap = new Database(dest, { readonly: true })
const integrity = snap.pragma('integrity_check', { simple: true })
const after = contentDigest(snap)
snap.close()

const ok = before.digest === after.digest && integrity === 'ok'
console.log(`snapshot: ${dest}`)
console.log(`size: ${statSync(dest).size} bytes`)
console.log(`source content digest:   ${before.digest}`)
console.log(`snapshot content digest: ${after.digest}`)
console.log(`rows: ${JSON.stringify(after.counts)}`)
console.log(`integrity_check: ${integrity}`)
console.log(ok ? 'VERIFIED: content-identical, integrity ok' : 'NOT VERIFIED')
process.exit(ok ? 0 : 1)
