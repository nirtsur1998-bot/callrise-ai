// STATE GUARD — restoration as mechanism, not as something I remember.
//
// WHY THIS EXISTS. Three separate incidents in one session, all the same shape:
// a check mutates state to set itself up, and restoring that state is a step I
// have to remember at the end.
//
//   1. A UI script saved a fake key over the founder's real DEEPGRAM key.
//      Unrecoverable — nothing had snapshotted ai-keys.
//   2. A script set aiProvider to 'anthropic' as setup, then hit a
//      refuse-and-exit path, and the restore never ran. Left their default on a
//      keyless provider.
//   3. Worse: that leftover 'anthropic' is what made BUG-143 fire on the
//      founder's own machine when they typed `junk` into the OpenAI card — the
//      app auto-selected a rejected key, exactly as the bug describes.
//
// Each time the fix was "be more careful". Three incidents says careful is not
// a mechanism. So: the unsafe path is made unrepresentable instead. You cannot
// run a mutating check through this without a snapshot, a finally-restore, and
// a post-run verification that shouts if the world did not come back.
//
// Deliberately NOT clever. It snapshots more than a given check needs, because
// the failure mode being prevented is precisely "I did not think that piece of
// state was in scope."
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync
} from 'node:fs'
import { join } from 'node:path'

const SETTINGS = 'C:/Users/User/AppData/Roaming/sales-os/app-settings.json'
const KEYS_DIR = 'C:/Users/User/AppData/Roaming/sales-os/ai-keys'

/**
 * The FULL BYTES of every key file, not a hash of them.
 *
 * ── 2026-08-31: THIS USED TO BE A FINGERPRINT, AND THAT WAS THE WRONG SHAPE ──
 *
 * It hashed each file and could therefore REPORT that a key had changed or
 * vanished. It could not put one back. The header above cites incident (1) —
 * a fake key written over the founder's real DEEPGRAM credential — as the
 * reason this module exists, and the module could not have undone it.
 *
 * It happened again on 2026-08-31, and was recoverable only because a snapshot
 * had been taken BY HAND, outside this tool. Worse, the README described this
 * function as snapshotting keys and restoring "in a finally", so a reader
 * mid-incident would have believed they had a rollback they did not have.
 *
 * The founder's framing, and it is the right one: **a detector that watches an
 * irreplaceable thing and cannot restore it is the wrong shape.** These files
 * are 35-90 bytes each and already encrypted at rest by safeStorage — we copy
 * the SAME encrypted bytes the disk holds, never plaintext, and only in memory.
 * Copying costs nothing and turns "I can tell you it changed" into "I can put
 * it back."
 */
function snapshotKeyFiles() {
  if (!existsSync(KEYS_DIR)) return {}
  return Object.fromEntries(readdirSync(KEYS_DIR).map((f) => [f, readFileSync(join(KEYS_DIR, f))]))
}

/** Content-addressed, so a rewrite with identical bytes is correctly a no-op. */
function fingerprintOf(files) {
  return Object.fromEntries(
    Object.entries(files).map(([f, buf]) => [f, `${buf.length}:${buf.toString('base64').slice(0, 32)}`])
  )
}

function snapshot() {
  const keyFiles = snapshotKeyFiles()
  return {
    settingsRaw: existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : null,
    keyFiles,
    keys: fingerprintOf(keyFiles),
    at: new Date().toISOString()
  }
}

/**
 * Put every key file back exactly as it was: rewrite anything changed or
 * deleted, remove anything added. Returns what it had to do, so the caller can
 * say so rather than restoring silently.
 *
 * Runs for ALL key files including those named in `allowKeyChanges`. That
 * option suppresses the FAILURE REPORT for a file the check was expected to
 * touch; it was never meant to leave a throwaway credential behind. Cleaning it
 * up by hand is exactly the "something I have to remember" this module exists
 * to delete.
 */
function restoreKeyFiles(before) {
  const rewritten = []
  const removed = []
  if (Object.keys(before).length > 0) mkdirSync(KEYS_DIR, { recursive: true })
  for (const [f, buf] of Object.entries(before)) {
    const p = join(KEYS_DIR, f)
    if (!existsSync(p) || !readFileSync(p).equals(buf)) {
      writeFileSync(p, buf, { mode: 0o600 })
      rewritten.push(f)
    }
  }
  if (existsSync(KEYS_DIR)) {
    for (const f of readdirSync(KEYS_DIR)) {
      if (!(f in before)) {
        unlinkSync(join(KEYS_DIR, f))
        removed.push(f)
      }
    }
  }
  return { rewritten, removed }
}

function diffKeys(before, after) {
  const out = []
  for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[f] !== after[f]) {
      out.push(`${f}: ${before[f] ? (after[f] ? 'CHANGED' : 'REMOVED') : 'ADDED'}`)
    }
  }
  return out
}

/**
 * Run `fn` with every piece of state this app's checks can touch snapshotted
 * first and restored afterwards — including on throw, on `process.exit` paths
 * the caller controls, and on refuse-and-exit.
 *
 * `allowKeyChanges` names key files the check is EXPECTED to add or remove
 * (e.g. the throwaway provider it saves to). Anything outside that list showing
 * up in the diff is reported as a failure, loudly, because that is exactly the
 * class of mistake incident (1) was.
 */
export async function withRestoredState(fn, { allowKeyChanges = [] } = {}) {
  const before = snapshot()
  console.log(`[state-guard] snapshot taken: settings + ${Object.keys(before.keys).length} key file(s)`)
  let result
  let threw
  try {
    result = await fn()
  } catch (e) {
    threw = e
  } finally {
    // RESTORE FIRST, REPORT SECOND. If this throws, the report below still runs.
    try {
      if (before.settingsRaw !== null) {
        const now = existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : null
        if (now !== before.settingsRaw) {
          writeFileSync(SETTINGS, before.settingsRaw)
          console.log('[state-guard] app-settings.json RESTORED from snapshot')
        }
      }
    } catch (e) {
      console.log('[state-guard] *** SETTINGS RESTORE FAILED: ' + e.message + ' ***')
    }

    // KEY FILES, restored rather than merely reported. See snapshotKeyFiles.
    try {
      const { rewritten, removed } = restoreKeyFiles(before.keyFiles)
      if (rewritten.length) console.log('[state-guard] key file(s) RESTORED: ' + rewritten.join(', '))
      if (removed.length) console.log('[state-guard] key file(s) REMOVED (not in snapshot): ' + removed.join(', '))
    } catch (e) {
      console.log('[state-guard] *** KEY RESTORE FAILED: ' + e.message + ' *** — the snapshot is still in memory for this process only; do NOT exit before recovering by hand')
    }

    // What the check actually did, captured BEFORE restoring, so the report can
    // say it. Without this the restore erases the evidence of its own necessity.
    const duringRun = fingerprintOf(snapshotKeyFiles())

    // VERIFY, do not assume the restore worked.
    const after = snapshot()
    const settingsOk = after.settingsRaw === before.settingsRaw
    // After restoration this should be EMPTY for every file, including the
    // allowed ones — an allowed change that survives the restore means the
    // restore did not work, which is worth shouting about rather than filtering
    // away. allowKeyChanges is applied to the DURING-RUN diff below, not here.
    const keyDiff = diffKeys(before.keys, after.keys)
    const unexpectedDuringRun = diffKeys(before.keys, duringRun).filter(
      (d) => !allowKeyChanges.some((a) => d.startsWith(a))
    )

    console.log('\n[state-guard] ── POST-RUN VERIFICATION ──')
    console.log(`  app-settings.json identical to snapshot: ${settingsOk ? 'YES' : '*** NO ***'}`)
    if (unexpectedDuringRun.length) {
      console.log('  *** UNEXPECTED KEY-FILE CHANGES DURING THE RUN — INVESTIGATE ***')
      unexpectedDuringRun.forEach((d) => console.log('    ' + d))
    }
    if (!keyDiff.length) console.log('  key files identical to snapshot: YES')
    else {
      console.log('  *** KEY FILES DID NOT COME BACK ***')
      keyDiff.forEach((d) => console.log('    ' + d))
    }
    if (!settingsOk || keyDiff.length) {
      console.log('\n  *** STATE DID NOT COME BACK. Do not trust this run, and check by hand. ***')
    }
  }
  if (threw) throw threw
  return result
}
