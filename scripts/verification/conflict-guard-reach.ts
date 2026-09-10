// BUG-187 / BUG-185 — is the conflict guard doing anything at all, and WHY not?
//
// `reconcileStore` keeps the losing side of a two-machine edit as `<id>.conflict`
// only when all of these hold (backup-core.ts:166-185):
//
//   (a) a cloud row exists for the id
//   (b) ts(row.server_updated_at) > toServerMs(local.updatedAt, skewMs)
//   (c) lastSyncAt is set AND ts(local.updatedAt) > ts(lastSyncAt)
//   (d) local.deleted !== true
//   (e) differsIgnoringTimestamp(local, payload)
//
// (e) is BUG-138's guard, added to stop an app killed mid-sync manufacturing one
// identical "conflict" per record. This script measures whether (e) can ever
// say no — and, when it cannot, WHICH normalisation is responsible.
//
// TWO THINGS THIS GOT WRONG THE FIRST TIME, both corrected here:
//
//  1. IT REPORTED 296/296. That is the predicate over the whole corpus. (d)
//     blocks tombstones upstream, so the REACHABLE population is the live
//     records only — 196, not 296. The old number appeared in two reports.
//  2. IT NAMED ONE CAUSE. `dealId` differs on every record, which is not the
//     same as being responsible: a leave-one-out shows several INDEPENDENT
//     normalisations each force (e) true on their own, so neutralising the
//     obvious one repairs nothing. That distinction decides the fix.
//
// `differsIgnoringTimestamp` is not exported, so it is EXTRACTED VERBATIM from
// backup-core.ts at runtime rather than reimplemented — a hand-copied predicate
// built from the same reading as the suspicion is how a measurement confirms
// what it set out to find (taxonomy species 97).
//
// usage: conflict-guard-reach.ts <userDataDir>
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { callBackupPayload, callFullBackupPayload, type Call } from '../../src/main/calls-fs'

const PROFILE = process.argv[2]
if (!PROFILE) throw new Error('usage: conflict-guard-reach.ts <userDataDir>')

/**
 * Extract whichever predicate `backup-core.ts` currently carries, and SAY WHICH.
 *
 * `differsIgnoringTimestamp` was replaced by `importWouldDiscard` when BUG-187
 * was fixed — a fix this script is what established the need for. Naming the
 * predicate in the output means a number produced here can never be quoted
 * against the wrong one. It still fails loudly when neither is present, rather
 * than silently measuring a stale copy; that refusal fired on the first run
 * after the rename, which is the behaviour it was built for.
 */
function extractPredicate(): { name: string; fn: (a: unknown, b: unknown) => boolean } {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', 'backup-core.ts'), 'utf8')
  const name = ['differsIgnoringTimestamp', 'importWouldDiscard'].find(
    (n) => src.indexOf(`function ${n}(`) !== -1
  )
  if (!name) {
    throw new Error(
      'neither differsIgnoringTimestamp nor importWouldDiscard is in backup-core.ts — ' +
        'the guard was renamed again. Update this script rather than trusting its output.'
    )
  }
  const start = src.indexOf(`function ${name}(`)
  const end = src.indexOf('\n}', start)
  if (end === -1) throw new Error(`could not find the end of ${name}`)
  const body = src
    .slice(start, end + 2)
    .replace(/: unknown/g, '')
    .replace(/: string/g, '')
    .replace(/: boolean/g, '')
    .replace(/ as Record<string, unknown>/g, '')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(`${body}; return ${name}`)() as (a: unknown, b: unknown) => boolean
  return { name, fn }
}

const predicate = extractPredicate()
const differs = predicate.fn
console.log(`predicate under measurement: ${predicate.name}()`)

const dir = join(PROFILE, 'calls')
const all: Call[] = []
for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  try {
    all.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Call)
  } catch {
    /* unreadable record — not this measurement's subject */
  }
}
// Condition (d): a tombstone can never reach the predicate.
const reachable = all.filter((c) => c.deleted !== true)
console.log(`records on disk: ${all.length}   tombstones blocked by (d): ${all.length - reachable.length}`)
console.log(`REACHABLE population — the only number that means anything: ${reachable.length}`)

/** Drop a key from both sides, so the predicate is asked whether that key was
 *  the only thing keeping it true. */
const without = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => {
  const out = { ...o }
  for (const k of keys) delete out[k]
  return out
}

for (const [label, build] of [
  ['transcripts OFF (callBackupPayload)', callBackupPayload],
  ['transcripts ON  (callFullBackupPayload)', callFullBackupPayload]
] as const) {
  const pairs = reachable.map((c) => ({
    local: c as unknown as Record<string, unknown>,
    payload: build(c) as Record<string, unknown>
  }))
  const stillDiffers = pairs.filter((p) => differs(p.local, p.payload)).length

  console.log(`\n${label}`)
  console.log(`  (e) says "these differ" for ${stillDiffers} of ${reachable.length} reachable records`)
  if (stillDiffers === reachable.length) console.log('  -> INERT: (e) can never prevent a conflict on this store.')

  // Which keys differ at all, and how often.
  const appears = new Map<string, number>()
  for (const { local, payload } of pairs) {
    for (const k of new Set([...Object.keys(local), ...Object.keys(payload)])) {
      if (k === 'updatedAt') continue
      if (JSON.stringify(local[k]) !== JSON.stringify(payload[k])) appears.set(k, (appears.get(k) ?? 0) + 1)
    }
  }
  const keys = [...appears.entries()].sort((a, b) => b[1] - a[1])
  console.log('  keys that differ:')
  for (const [k, n] of keys) console.log(`     ${String(n).padStart(4)}  ${k}`)

  // LEAVE-ONE-OUT: is this key the SOLE reason (e) is true?
  console.log('  leave-one-out — neutralise this key alone, does (e) go quiet?')
  for (const [k] of keys) {
    const quiet = pairs.filter((p) => !differs(without(p.local, [k]), without(p.payload, [k]))).length
    console.log(`     ${String(quiet).padStart(4)} of ${reachable.length}  silenced by neutralising ${k} alone`)
  }

  // CUMULATIVE: neutralise the whole set. If (e) is still true, the causes are
  // over-determined and no single repair reaches it.
  const allKeys = keys.map(([k]) => k)
  const quietAll = pairs.filter((p) => !differs(without(p.local, allKeys), without(p.payload, allKeys))).length
  console.log(`  neutralising ALL ${allKeys.length} differing keys silences ${quietAll} of ${reachable.length}`)
}
