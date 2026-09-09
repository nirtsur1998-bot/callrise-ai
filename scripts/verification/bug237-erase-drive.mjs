// BUG-237 — the erase path, driven against a real store through the
// PRODUCTION code path. The evidence behind the M37 release note; kept so the
// claim is reproducible rather than a sentence someone has to believe.
//
// WHY IT LOOKS LIKE THIS. The Memory Center sits behind the app's auth screen,
// and three constraints ruled out every more obvious instrument:
//
//   * the packaged build cannot be pointed at a sandbox — the profile-override
//     seam is `app.isPackaged ? undefined : …` on purpose (see index.ts), so
//     the shipped artifact always uses the real %APPDATA%\sales-os
//   * pressing "Forget everything" against the real profile is not a test, it
//     is data loss
//   * RDP input to the Stage 2 VM was dead in both channels that night
//     (memory: driving-a-windows-vm-over-rdp)
//
// The way through: the auth screen is a REACT gate. The preload bridge and
// every main-process IPC handler are live behind it. So a logged-out sandbox
// app on a copied profile exercises the real chain end to end —
//
//   window.api.salesBrain.memories.forgetEverything()
//     -> preload bridge -> ipcMain 'salesBrain:memories:forgetEverything'
//     -> isSalesBrainEnabled() gate -> memory.db
//
// WHAT THIS DOES NOT COVER, said here rather than left to be discovered:
// React's own click handling. That is covered by
// src/renderer/src/features/settings/__tests__/forget-everything.render.test.ts.
// Neither half is the whole proof and neither is presented as one.
//
// SETUP (the database must be REAL and non-empty — a 0 -> 0 pass proves
// nothing, which is the same mistake BUG-237 itself was):
//
//   node scripts/verification/memory-snapshot.mjs \
//     "$APPDATA/sales-os/memory.db" <sandbox-dir>          # verified copy
//   mv <sandbox-dir>/memory-*.db <sandbox-dir>/memory.db
//   cp "$APPDATA/sales-os/app-settings.json" <sandbox-dir>
//   cp -r out out-sandbox
//   CALLRISE_USER_DATA_DIR=<sandbox-dir> ./node_modules/.bin/electron \
//     out-sandbox/main/index.js --remote-debugging-port=9444
//
// Do NOT copy supabase-auth.json in. BUG-186 exists because that exact copy
// once pushed to the founder's real backend within a minute of starting; the
// sandbox refuses sync now, but the drive does not need an account at all.
//
//   usage: node bug237-erase-drive.mjs <sandbox-dir> [port]
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { connect } from './cdp.mjs'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')

const SANDBOX = process.argv[2]
const PORT = Number(process.argv[3] || 9444)
if (!SANDBOX) {
  console.error('usage: node bug237-erase-drive.mjs <sandbox-dir> [port]')
  process.exit(2)
}
const DB = join(SANDBOX, 'memory.db')

/** Count rows straight from the file, read-only. THE independent measurement.
 *  The whole bug was a handler whose return value said nothing, so the return
 *  value is not what decides whether this passes. */
function rowsOnDisk() {
  const db = new Database(DB, { readonly: true })
  try {
    return db.prepare('SELECT COUNT(*) AS n FROM memories').get().n
  } finally {
    db.close()
  }
}

let failures = 0
const fail = (msg) => {
  console.log('  FAIL: ' + msg)
  failures += 1
}

const cdp = await connect(PORT)
// RULE 1 — confirm the build before believing anything it says. A sandbox
// drive against the founder's real dev app would erase their Sales Brain.
if (!cdp.page.url.includes('out-sandbox')) {
  throw new Error(
    `REFUSING: page url is ${cdp.page.url}, which is not an out-sandbox build. ` +
      'This drive erases every memory in the profile it is pointed at.'
  )
}
console.log('[build] ' + cdp.page.url)

const hasApi = await cdp.evaluate(
  `typeof window.api?.salesBrain?.memories?.forgetEverything === 'function'`
)
if (!hasApi) throw new Error('no forgetEverything on the preload bridge — wrong build, or preload failed')
console.log('[bridge] window.api.salesBrain.memories.forgetEverything is present')

// ── 1. Sales Brain ON: it really erases ─────────────────────────────────────
console.log('\n--- 1. Sales Brain ON — the erase must actually erase ---')
await cdp.evaluate(`(async () => { await window.api.settings.update({ salesBrain: { enabled: true } }) })()`)

const before = rowsOnDisk()
console.log(`  [db]  memories on disk BEFORE: ${before}`)
if (before === 0) {
  throw new Error('the sandbox database is empty — a 0 -> 0 pass would prove nothing. Snapshot a real store first.')
}
const listedBefore = await cdp.evaluate(`(async () => (await window.api.salesBrain.memories.list()).length)()`)
console.log(`  [ipc] memories.list() BEFORE: ${listedBefore}`)

const okRes = await cdp.evaluate(
  `(async () => JSON.stringify(await window.api.salesBrain.memories.forgetEverything()))()`
)
console.log(`  [ipc] forgetEverything() returned: ${okRes}`)

const afterOn = rowsOnDisk()
const listedAfter = await cdp.evaluate(`(async () => (await window.api.salesBrain.memories.list()).length)()`)
console.log(`  [db]  memories on disk AFTER:  ${afterOn}`)
console.log(`  [ipc] memories.list() AFTER:  ${listedAfter}`)

if (JSON.parse(okRes)?.ok !== true) fail(`expected ok:true, got ${okRes}`)
if (afterOn !== 0) fail(`the database still holds ${afterOn} memories after the erase`)
if (listedAfter !== 0) fail(`the IPC list still returns ${listedAfter} memories after the erase`)
if (!failures) console.log(`  PASS — ${before} -> ${afterOn}, counted from the database file.`)

// ── 2. Sales Brain OFF: it refuses, and the refusal is INVISIBLE ────────────
//
// The point is not that the handler refuses. It is that below the UI the
// refusal cannot be told from a success: nothing throws, nothing logs, the
// database is untouched, and the return value is a bare {ok:false}. That is
// why the fixed UI must not OFFER the button, not merely disable it.
console.log('\n--- 2. Sales Brain OFF — the refusal, and how silent it is ---')
console.log('  (restore the database snapshot before this section for a non-zero reading)')
const beforeOff = rowsOnDisk()
const off = await cdp.evaluate(
  `(async () => JSON.stringify((await window.api.settings.update({ salesBrain: { enabled: false } })).salesBrain))()`
)
console.log(`  [settings] salesBrain now = ${off}`)
if (JSON.parse(off).enabled !== false) throw new Error('could not turn Sales Brain off')

const refusal = await cdp.evaluate(
  `(async () => JSON.stringify(await window.api.salesBrain.memories.forgetEverything()))()`
)
const afterOff = rowsOnDisk()
console.log(`  [ipc] forgetEverything() with Sales Brain OFF returned: ${refusal}`)
console.log(`  [db]  memories on disk: ${beforeOff} -> ${afterOff}`)

if (JSON.parse(refusal)?.ok !== false) fail(`expected a refusal, got ${refusal}`)
if (afterOff !== beforeOff) fail(`the database changed while Sales Brain was off: ${beforeOff} -> ${afterOff}`)

// Leave the sandbox as it was found.
const back = await cdp.evaluate(
  `(async () => JSON.stringify((await window.api.settings.update({ salesBrain: { enabled: true } })).salesBrain))()`
)
if (JSON.parse(back).enabled !== true) fail('failed to restore the setting')
console.log(`  [settings] restored to ${back}`)

console.log('\n════════════════════════════════════════')
console.log(
  failures
    ? `*** ${failures} FAILURE(S) ***`
    : 'PASS — erases when on, refuses and changes nothing when off, both measured from the database file.'
)
cdp.close()
process.exit(failures ? 1 : 0)
