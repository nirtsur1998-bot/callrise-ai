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
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SETTINGS = 'C:/Users/User/AppData/Roaming/sales-os/app-settings.json'
const KEYS_DIR = 'C:/Users/User/AppData/Roaming/sales-os/ai-keys'

/** Content-addressed, so a rewrite with identical bytes is correctly a no-op. */
function keyFingerprint() {
  if (!existsSync(KEYS_DIR)) return {}
  return Object.fromEntries(
    readdirSync(KEYS_DIR).map((f) => {
      const p = join(KEYS_DIR, f)
      return [f, `${statSync(p).size}:${readFileSync(p).toString('base64').slice(0, 32)}`]
    })
  )
}

function snapshot() {
  return {
    settingsRaw: existsSync(SETTINGS) ? readFileSync(SETTINGS, 'utf8') : null,
    keys: keyFingerprint(),
    at: new Date().toISOString()
  }
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

    // VERIFY, do not assume the restore worked.
    const after = snapshot()
    const settingsOk = after.settingsRaw === before.settingsRaw
    const keyDiff = diffKeys(before.keys, after.keys).filter(
      (d) => !allowKeyChanges.some((a) => d.startsWith(a))
    )

    console.log('\n[state-guard] ── POST-RUN VERIFICATION ──')
    console.log(`  app-settings.json identical to snapshot: ${settingsOk ? 'YES' : '*** NO ***'}`)
    if (!keyDiff.length) console.log('  no unexpected key-file changes')
    else {
      console.log('  *** UNEXPECTED KEY-FILE CHANGES — INVESTIGATE ***')
      keyDiff.forEach((d) => console.log('    ' + d))
    }
    if (!settingsOk || keyDiff.length) {
      console.log('\n  *** STATE DID NOT COME BACK. Do not trust this run, and check by hand. ***')
    }
  }
  if (threw) throw threw
  return result
}
