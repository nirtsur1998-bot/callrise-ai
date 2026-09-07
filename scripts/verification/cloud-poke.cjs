/**
 * Put a test object into, or delete one from, this user's own Storage prefix
 * — so the app's scrub can be tested against something it did not upload.
 *
 * BUG-200 front 3. `scrubSalesBrainDb` lists the whole `<userId>/` prefix and
 * removes everything it finds, rather than deleting the one name the current
 * build happens to write. The reason is a real one: a file left by an older
 * build under a different name would otherwise survive an erase forever, and
 * the user would be told their brain was deleted while it sat there. That
 * behaviour is untestable without an object under a name this build never
 * writes, which is what this creates.
 *
 * Also used to probe RLS directly: `--delete-as-other` attempts a delete
 * against a row that is not this user's, to show the server refuses rather
 * than to take it on trust.
 *
 * Shares the session-reading approach of cloud-state.cjs and, like it, never
 * prints a token or the anon key.
 *
 * Usage (under Electron, not node):
 *   ... cloud-poke.cjs --put   <bucket> <relative name> <contents>
 *   ... cloud-poke.cjs --del   <bucket> <relative name>
 *   ... cloud-poke.cjs --probe-rls <table>
 */
const { app, safeStorage } = require('electron')
const { readFileSync, mkdirSync, existsSync, copyFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const REPO = join(__dirname, '..', '..')
const argv = process.argv.slice(1)
const LIVE_PROFILE = join(process.env.APPDATA || '', 'sales-os')
const SCRATCH = join(os.tmpdir(), 'callrise-cloud-poke-profile')

function die(m) {
  process.stderr.write('FAILED: ' + m + '\n')
  app.exit(1)
}
function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

// Before ready: Electron's OSCrypt binds its key at startup.
rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
copyFileSync(join(LIVE_PROFILE, 'Local State'), join(SCRATCH, 'Local State'))
app.setPath('userData', SCRATCH)

function projectConfig() {
  const src = readFileSync(join(REPO, 'src', 'main', 'default-config.ts'), 'utf8')
  const url = /SUPABASE_URL:\s*'([^']+)'/.exec(src)
  const anon = /SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(src)
  if (!url || !anon) die('could not read the project config')
  return { url: url[1], anon: anon[1] }
}

function readSession(cfg) {
  const p = join(LIVE_PROFILE, 'supabase-auth.json')
  if (!existsSync(p)) die('no session file')
  const outer = safeJson(safeStorage.decryptString(readFileSync(p)))
  const ref = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(cfg.url)[1]
  const wanted = `sb-${ref}-auth-token`
  if (!(wanted in outer)) die(`no session for this project (${wanted}); refusing another project's token`)
  const e = typeof outer[wanted] === 'string' ? safeJson(outer[wanted]) : outer[wanted]
  const tok = e.access_token || (e.currentSession && e.currentSession.access_token)
  if (!tok) die('no access_token')
  const sub = JSON.parse(
    Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
  ).sub
  return { token: tok, userId: sub }
}

app.whenReady().then(async () => {
  const cfg = projectConfig()
  const { token, userId } = readSession(cfg)
  const H = { apikey: cfg.anon, Authorization: `Bearer ${token}` }

  const mode = argv.find((a) => a.startsWith('--'))
  const rest = argv.slice(argv.indexOf(mode) + 1)

  if (mode === '--put') {
    const [bucket, name, contents] = rest
    const path = `${userId}/${name}`
    const res = await fetch(`${cfg.url}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/octet-stream', 'x-upsert': 'true' },
      body: Buffer.from(contents || 'planted by the BUG-200 proof', 'utf8')
    })
    console.log(JSON.stringify({ put: path, status: res.status, body: (await res.text()).slice(0, 200) }, null, 2))
  } else if (mode === '--del') {
    const [bucket, name] = rest
    const path = `${userId}/${name}`
    const res = await fetch(`${cfg.url}/storage/v1/object/${bucket}/${path}`, {
      method: 'DELETE',
      headers: H
    })
    console.log(JSON.stringify({ deleted: path, status: res.status, body: (await res.text()).slice(0, 200) }, null, 2))
  } else if (mode === '--probe-rls') {
    // Attempt a delete scoped to a user id that is NOT this user's. The server
    // must refuse or affect nothing. Proving RLS rather than assuming it.
    const [table] = rest
    const other = '00000000-0000-4000-8000-000000000000'
    const res = await fetch(`${cfg.url}/rest/v1/${table}?user_id=eq.${other}`, {
      method: 'DELETE',
      headers: { ...H, Prefer: 'return=representation' }
    })
    const body = await res.text()
    console.log(
      JSON.stringify(
        {
          table,
          attemptedUserId: other,
          thisUserId: userId,
          status: res.status,
          rowsReturned: safeJson(body)?.length ?? null,
          body: body.slice(0, 200)
        },
        null,
        2
      )
    )
  } else {
    die('unknown mode: ' + mode)
  }
  rmSync(SCRATCH, { recursive: true, force: true })
  app.exit(0)
})
