/**
 * BUG-187 — drive the REAL conflict path inside a REAL Electron main process.
 *
 * WHAT THIS IS AND IS NOT, stated up front because the difference is the whole
 * value of the run:
 *
 *   - The `reconcileStore` that runs here is the app's own module, bundled by
 *     the same bundler the real main build uses. So is `importCall`. So are
 *     the call records: real ones, copied.
 *   - The cloud rows are built from `cloud-ratchet.cjs`'s actual read of the
 *     founder's Supabase table, so `server_updated_at` and `updated_at` are the
 *     values the server really holds, not values chosen to make a point.
 *   - `lastSyncAt` and `clockSkewMs` come from the founder's real backup-state.
 *   - The ONE thing not exercised is the socket. There is no honest way to add
 *     it: the sandbox profile deliberately refuses the cloud (BUG-186), and
 *     pointing a sandbox at the real project to complete a round trip is
 *     exactly what that guard exists to prevent. Defeating one fix's guard to
 *     demonstrate another fix is not a demonstration.
 *
 * READ-ONLY with respect to the founder's profile. Records are COPIED into a
 * scratch directory; every write this script causes happens there.
 *
 * usage:
 *   electron.exe conflict-guard-in-app.cjs --profile <userDataDir>
 *                                          --rows <ratchet-*.json> --out <dir>
 */
const { app } = require('electron')
const { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')

const args = process.argv.slice(1)
const argOf = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const PROFILE = argOf('--profile')
const ROWS_FILE = argOf('--rows')
const OUT = argOf('--out')
if (!PROFILE || !ROWS_FILE || !OUT) {
  process.stderr.write('usage: --profile <userDataDir> --rows <ratchet.json> --out <dir>\n')
  app.exit(2)
}

const REPO = join(__dirname, '..', '..')
const ENTRY = join(__dirname, '_conflict-entry.ts')

/**
 * Bundle the modules under test and load THAT — do not require the app's own
 * `out/main/index.js`, because requiring it starts the application against
 * whatever profile is current. The bundler is esbuild, the same one
 * electron-vite runs for the real main build, over the same sources; the
 * `external` list matches how the app's own main bundle treats them.
 */
function loadAppModule() {
  // INSIDE THE REPO, deliberately: Node resolves a bundle's bare requires from
  // the bundle's own directory upward, so a bundle written to the system temp
  // directory cannot find the app's node_modules and dies on the first
  // dependency.
  const bundleDir = join(REPO, 'node_modules', '.callrise-verify')
  mkdirSync(bundleDir, { recursive: true })
  const bundled = join(bundleDir, 'under-test.cjs')
  const esbuild = join(REPO, 'node_modules', 'esbuild', 'lib', 'main.js')
  if (!existsSync(esbuild)) throw new Error('esbuild is not installed — cannot bundle the modules under test')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require(esbuild).buildSync({
    entryPoints: [ENTRY],
    outfile: bundled,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // Bundle the app's own sources; resolve every dependency at runtime the way
    // the app does. Inlining them instead drags in native `.node` binaries
    // (onnxruntime, sharp) that esbuild has no loader for.
    packages: 'external',
    external: ['electron']
  })
  return require(bundled)
}

/** Copy live call records into a scratch store. Never the founder's directory. */
function seedStore(dest, howMany) {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const src = join(PROFILE, 'calls')
  const out = []
  for (const f of readdirSync(src).filter((x) => x.endsWith('.json'))) {
    let rec
    try {
      rec = JSON.parse(readFileSync(join(src, f), 'utf8'))
    } catch {
      continue // an unreadable record is not this measurement's subject
    }
    if (rec.deleted === true) continue // condition (d) blocks tombstones
    writeFileSync(join(dest, f), JSON.stringify(rec), 'utf8')
    out.push(rec)
    if (out.length >= howMany) break
  }
  return out
}

const countConflicts = (dir) => readdirSync(dir).filter((f) => f.endsWith('.conflict')).length

async function main() {
  mkdirSync(OUT, { recursive: true })
  const mod = loadAppModule()
  const { reconcileStore, importCall, callBackupPayload } = mod
  for (const [name, fn] of Object.entries({ reconcileStore, importCall, callBackupPayload })) {
    if (typeof fn !== 'function') {
      throw new Error(
        `${name} is not exported from the bundle under test. This script must ` +
          'fail rather than fall back to another copy — a fallback would measure ' +
          'something other than what ships.'
      )
    }
  }

  const state = JSON.parse(readFileSync(join(PROFILE, 'backup-state.json'), 'utf8'))
  const skewMs = state.clockSkewMs ?? 0
  const cloud = JSON.parse(readFileSync(ROWS_FILE, 'utf8'))
  const byId = new Map(cloud.rows.filter((r) => !r.deleted).map((r) => [r.id, r]))

  const scratch = join(OUT, 'store')
  const seeded = seedStore(scratch, 400).filter((r) => byId.has(r.id))
  if (!seeded.length) throw new Error('no seeded record matched a cloud row')

  // ARM CONDITION (c) THE WAY A USER DOES. `lastSyncAt` gates on "did the local
  // record move since the last sync"; the honest way to make that true is a
  // local edit after that cursor, which is what a person renaming a call on a
  // second machine produces. Set the cursor behind the records rather than
  // forging a timestamp onto them.
  const lastSyncAt = new Date(
    Math.min(...seeded.map((r) => Date.parse(r.updatedAt))) - 60_000
  ).toISOString()

  const report = {
    ranAt: new Date().toISOString(),
    bundledFrom: ENTRY,
    cloudSample: { file: ROWS_FILE, readAt: cloud.readAt, query: cloud.query },
    skewMs,
    lastSyncAt,
    records: seeded.length,
    scenarios: []
  }

  const SCENARIOS = [
    { key: 'untouched', label: "BUG-138's case — nothing edited on either side", expect: 0 },
    {
      key: 'renamed',
      label: 'genuine conflict — the other machine renamed the call',
      expect: seeded.length,
      edit: (p) => {
        p.title = 'renamed on the other machine'
      }
    }
  ]

  // THE OTHER MACHINE'S PUSH INSTANT, and the first version of this script got
  // it wrong in a way worth keeping written down.
  //
  // It used each row's own historical `server_updated_at` straight from the
  // sample. But the app had already pulled that row: by the time the script
  // ran, the local record carried exactly `server_updated_at - skew`, so
  // condition (b) evaluated `cloudT <= localOnServerT` as equal, every record
  // was skipped, and BOTH scenarios reported 0 conflict files. One of them
  // called that a PASS.
  //
  // It was a pass over zero imports — the guard never ran. `recordsImported` is
  // asserted below precisely so that cannot be mistaken for a result again.
  //
  // A genuine two-machine conflict means the OTHER machine pushed after this
  // one's last sync. That is what this models, and it is the only arrangement
  // in which the conflict path is reachable at all.
  const otherMachinePushedAt = new Date(Date.now() + 5_000).toISOString()
  report.otherMachinePushedAt = otherMachinePushedAt

  for (const s of SCENARIOS) {
    seedStore(scratch, 400)
    const rows = seeded.map((local) => {
      const cloudRow = byId.get(local.id)
      const payload = callBackupPayload(local)
      if (s.edit) s.edit(payload)
      return {
        id: local.id,
        // The real value the server holds, kept for the record...
        updated_at: cloudRow.updated_at,
        // ...and the instant the other machine's write was accepted.
        server_updated_at: otherMachinePushedAt,
        deleted: false,
        payload
      }
    })
    const locals = new Map(seeded.map((r) => [r.id, r]))
    const changed = await reconcileStore(scratch, rows, locals, importCall, lastSyncAt, skewMs)
    const conflicts = countConflicts(scratch)
    // A conflict count is only evidence if the import actually happened.
    const pass = conflicts === s.expect && changed === seeded.length
    report.scenarios.push({
      scenario: s.label,
      recordsImported: changed,
      conflictFilesWritten: conflicts,
      expected: s.expect,
      verdict: pass ? 'PASS' : 'FAIL'
    })
    process.stdout.write(
      `  ${String(conflicts).padStart(4)}/${seeded.length} .conflict files  ` +
        `${(pass ? 'PASS' : 'FAIL').padEnd(6)} ${s.label}\n`
    )
  }

  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'in-app-conflict.json'), JSON.stringify(report, null, 2), 'utf8')
  process.stdout.write(`\nreport: ${join(OUT, 'in-app-conflict.json')}\n`)
  app.exit(report.scenarios.every((s) => s.verdict === 'PASS') ? 0 : 1)
}

app
  .whenReady()
  .then(main)
  .catch((e) => {
    process.stderr.write('FAILED: ' + (e && e.stack ? e.stack : String(e)) + '\n')
    app.exit(1)
  })
