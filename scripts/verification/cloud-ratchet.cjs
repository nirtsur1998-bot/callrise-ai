/**
 * BUG-185 — WATCH THE RATCHET ADVANCE, rather than reading the trigger's source
 * and reasoning about it.
 *
 * The loop this measures: `reconcileStore` stamps every incoming record's
 * `updatedAt` from the cloud row's `server_updated_at` (backup-core.ts:151),
 * which is the instant the SERVER ACCEPTED the write and therefore always later
 * than the `updated_at` the pusher sent. The next push uploads that raised
 * value, the trigger accepts it as newer and stamps a fresh `server_updated_at`,
 * and ten minutes later it happens again. Every record, every cycle, one
 * device, nobody editing anything.
 *
 * Every step of that was established from source. This is the one link that was
 * never measured: does `server_updated_at` actually advance on rows nobody
 * touched, cycle after cycle?
 *
 * READ-ONLY, and structurally so: one GET per sample against PostgREST with
 * `select=id,updated_at,server_updated_at`. No POST, PATCH, DELETE or RPC, no
 * policy or schema statement. Modelled on cloud-state.cjs, which was built for
 * the BUG-200 erase proof, and shares its three safety properties:
 *
 *  - it runs under Electron with a THROWAWAY user-data directory holding a COPY
 *    of `Local State`, so the live profile is never opened for writing;
 *  - the access token and anon key are used as headers and never printed — the
 *    output is asserted against the actual secret values before a byte is
 *    written, and the process exits non-zero rather than print;
 *  - it selects the session by PROJECT REF rather than taking whichever comes
 *    first, and fails closed if the expected key is absent (cloud-state.cjs
 *    learned that the hard way: the old project's JWT read as "everything is
 *    empty", which on a deletion test is a false green).
 *
 * Usage — take a sample, wait for the app's next sync, take another:
 *   node_modules/electron/dist/electron.exe scripts/verification/cloud-ratchet.cjs \
 *     --label A --out <dir> [--ids <n>]
 *   ... then --label B, and compare.
 */
const { app, safeStorage } = require('electron')
const { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const os = require('node:os')

const REPO = join(__dirname, '..', '..')
const args = process.argv.slice(1)
const argOf = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const LABEL = argOf('--label') || 'sample'
const OUT_DIR = argOf('--out')
const HOW_MANY = Number(argOf('--ids') || 8)

const LIVE_PROFILE = join(process.env.APPDATA || '', 'sales-os')
const SCRATCH = join(os.tmpdir(), 'callrise-cloud-ratchet-profile')

function die(msg) {
  process.stderr.write('FAILED: ' + msg + '\n')
  app.exit(1)
}

function useScratchProfile() {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  const src = join(LIVE_PROFILE, 'Local State')
  if (!existsSync(src)) die(`no "Local State" at ${src} — cannot decrypt the session`)
  copyFileSync(src, join(SCRATCH, 'Local State'))
  app.setPath('userData', SCRATCH)
}

function projectConfig() {
  const src = readFileSync(join(REPO, 'src', 'main', 'default-config.ts'), 'utf8')
  const url = /SUPABASE_URL:\s*'([^']+)'/.exec(src)
  const anon = /SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(src)
  if (!url || !anon) die('could not read SUPABASE_URL / SUPABASE_ANON_KEY from default-config.ts')
  return { url: url[1], anon: anon[1] }
}

const safeJson = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function readSession(cfg) {
  const p = join(LIVE_PROFILE, 'supabase-auth.json')
  if (!existsSync(p)) die(`no session file at ${p} — is the app signed in?`)
  if (!safeStorage.isEncryptionAvailable()) die('safeStorage reports encryption unavailable')
  let decrypted
  try {
    decrypted = safeStorage.decryptString(readFileSync(p))
  } catch (e) {
    die('could not decrypt the session file: ' + e.message)
  }
  const outer = safeJson(decrypted)
  if (!outer) die('session decrypted but is not JSON')
  const ref = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(cfg.url)
  if (!ref) die('could not derive the project ref from ' + cfg.url)
  const wanted = `sb-${ref[1]}-auth-token`
  if (!(wanted in outer)) {
    die(
      `the session file has no entry for this project (${wanted}). It holds: ` +
        `${Object.keys(outer).join(', ')}. Refusing to fall back to another project's token.`
    )
  }
  const entry = typeof outer[wanted] === 'string' ? safeJson(outer[wanted]) : outer[wanted]
  const tok = entry && (entry.access_token || (entry.currentSession && entry.currentSession.access_token))
  if (typeof tok !== 'string' || tok.length < 20) die(`${wanted} carries no access_token`)
  return { token: tok }
}

function userIdFrom(token) {
  const part = token.split('.')[1]
  const claims = safeJson(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  if (!claims || !claims.sub) die('could not read the sub claim from the session token')
  return claims.sub
}

/** The one query. Named here so a report can quote it verbatim. */
function queryUrl(cfg, userId, limit) {
  return (
    `${cfg.url}/rest/v1/backup_calls` +
    `?select=id,updated_at,server_updated_at,deleted` +
    `&user_id=eq.${encodeURIComponent(userId)}` +
    `&order=id.asc&limit=${limit}`
  )
}

async function main() {
  const cfg = projectConfig()
  const { token } = readSession(cfg)
  const userId = userIdFrom(token)
  const url = queryUrl(cfg, userId, HOW_MANY)

  const res = await fetch(url, {
    method: 'GET', // read-only, stated rather than implied
    headers: { apikey: cfg.anon, Authorization: `Bearer ${token}` }
  })
  const body = await res.text()
  if (!res.ok) die(`GET backup_calls -> ${res.status}: ${body.slice(0, 300)}`)
  const rows = safeJson(body)
  if (!Array.isArray(rows)) die('backup_calls did not return an array')

  const snapshot = {
    label: LABEL,
    readAt: new Date().toISOString(),
    project: cfg.url,
    // The exact query, with the user id redacted — so the report can say what
    // was asked, not just what came back.
    query: queryUrl(cfg, '<user-id>', HOW_MANY),
    rowCount: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      updated_at: r.updated_at,
      server_updated_at: r.server_updated_at,
      deleted: r.deleted === true,
      /** The ratchet's own gap: how far the server's accept instant sits ahead
       *  of the value the device uploaded. This is what makes the cloud copy
       *  newer than the local record that produced it. */
      serverAheadOfDeviceMs:
        Date.parse(r.server_updated_at) - Date.parse(r.updated_at)
    }))
  }

  const text = JSON.stringify(snapshot, null, 2)
  for (const [name, secret] of [
    ['access token', token],
    ['anon key', cfg.anon]
  ]) {
    if (text.includes(secret) || text.includes(secret.slice(0, 32))) {
      die(`REFUSING TO PRINT: the ${name} reached the output`)
    }
  }
  if (text.includes(userId)) die('REFUSING TO PRINT: the user id reached the output')

  process.stdout.write(text + '\n')
  if (OUT_DIR) {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, `ratchet-${LABEL}.json`), text, 'utf8')
  }
  app.exit(0)
}

// MUST run before the app is ready, and this script got it wrong on its first
// attempt despite cloud-state.cjs carrying the lesson twenty lines from where
// it was copied. Electron's OSCrypt initialises its app-bound key on startup
// from whatever userData is current AT THAT MOMENT; switching the path inside
// whenReady() is too late and decryption fails against a key this process just
// minted for an empty profile. The error says "Error while decrypting the
// ciphertext", which reads like a corrupt session rather than a late setting.
useScratchProfile()

app.whenReady().then(main).catch((e) => die(e && e.message ? e.message : String(e)))
