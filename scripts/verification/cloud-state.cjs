/**
 * READ THE SERVER, NOT THE APP'S REPORT OF IT.
 *
 * BUG-200 / BUG-202 verification instrument. Asks Supabase directly what this
 * user's account currently holds. It shares NO code with src/main/backup.ts —
 * separate process, its own HTTP requests, its own parsing — so a bug in the
 * app's push, scrub or status logic cannot make this agree with the app. That
 * is the point: "erased" from the app is a claim; this is the check.
 *
 * WHY IT RUNS UNDER ELECTRON RATHER THAN NODE. The session on disk is
 * encrypted with Electron's safeStorage, which on Windows is an app-bound AES
 * key held in `Local State` and itself DPAPI-protected. Plain Node cannot read
 * it. So this runs under the repo's own Electron binary, with a THROWAWAY
 * user-data directory holding a COPY of `Local State` — it never opens, locks
 * or writes the live profile.
 *
 * WHAT IT NEVER PRINTS. The access token, the refresh token and the anon key
 * are used as request headers and never reach stdout, the JSON output or any
 * file. The output is asserted against the actual secret values before a
 * single byte is printed, and the process exits non-zero rather than print.
 *
 * Usage:
 *   node_modules/electron/dist/electron.exe scripts/verification/cloud-state.cjs \
 *     --label BEFORE --out <dir>
 */
const { app, safeStorage } = require('electron')
const { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { createHash } = require('node:crypto')
const os = require('node:os')

const REPO = join(__dirname, '..', '..')
const args = process.argv.slice(1)
const argOf = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const LABEL = argOf('--label') || 'read'
const OUT_DIR = argOf('--out')

const LIVE_PROFILE = join(process.env.APPDATA || '', 'sales-os')
const SCRATCH = join(os.tmpdir(), 'callrise-cloud-state-profile')

function die(msg) {
  process.stderr.write('FAILED: ' + msg + '\n')
  app.exit(1)
}

/** A throwaway profile carrying only a COPY of the key material, so the live
 *  profile is never opened for writing by this process. */
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

function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * The session for THIS project, chosen by project ref rather than by being
 * first in the file.
 *
 * This profile holds TWO sessions — `sb-fphvsuvpskqwkcpiocfz-auth-token` for a
 * decommissioned project and `sb-emsbcxwzbjttxpimvlnj-auth-token` for the live
 * one. Taking whichever came first sent the OLD project's JWT to the new
 * project, which answered "No suitable key was found to decode the JWT" on
 * every table and a confusing ES256 complaint on every bucket. Read as
 * "everything is empty" that would have been a false green on a deletion
 * test — the most expensive direction. Selected explicitly, and failing
 * closed when the expected key is absent.
 */
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
  const present = Object.keys(outer)
  if (!(wanted in outer)) {
    die(
      `the session file has no entry for this project (${wanted}). ` +
        `It holds: ${present.join(', ')}. Refusing to fall back to another project's token.`
    )
  }
  const entry = typeof outer[wanted] === 'string' ? safeJson(outer[wanted]) : outer[wanted]
  const tok = entry && (entry.access_token || (entry.currentSession && entry.currentSession.access_token))
  if (typeof tok !== 'string' || tok.length < 20) die(`${wanted} carries no access_token`)
  const exp = entry.expires_at || (entry.currentSession && entry.currentSession.expires_at) || null
  return { token: tok, expiresAt: exp, otherProjectSessions: present.filter((k) => k !== wanted) }
}

/** The `sub` claim — the only thing taken out of the token. */
function userIdFrom(token) {
  const body = token.split('.')[1]
  if (!body) die('access token is not a JWT')
  const json = safeJson(
    Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  )
  if (!json || !json.sub) die('access token carries no subject claim')
  return json.sub
}

async function listBucket(cfg, token, bucket, prefix) {
  const res = await fetch(`${cfg.url}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: {
      apikey: cfg.anon,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ prefix, limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' } })
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 300) }
  const rows = safeJson(text) || []
  return {
    ok: true,
    status: res.status,
    count: rows.length,
    objects: rows.map((r) => ({
      name: r.name,
      size: (r.metadata && r.metadata.size) || null,
      updatedAt: r.updated_at || null,
      mimetype: (r.metadata && r.metadata.mimetype) || null
    }))
  }
}

async function countRows(cfg, token, table, userId) {
  const res = await fetch(
    `${cfg.url}/rest/v1/${table}?select=user_id&user_id=eq.${encodeURIComponent(userId)}`,
    {
      headers: {
        apikey: cfg.anon,
        Authorization: `Bearer ${token}`,
        Prefer: 'count=exact',
        Range: '0-0'
      }
    }
  )
  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 200) }
  const cr = res.headers.get('content-range') || ''
  const m = /\/(\d+|\*)$/.exec(cr)
  return { ok: true, status: res.status, total: m && m[1] !== '*' ? Number(m[1]) : null }
}

async function main() {
  const cfg = projectConfig()
  const { token, expiresAt, otherProjectSessions } = readSession(cfg)
  const userId = userIdFrom(token)

  const snapshot = {
    label: LABEL,
    readAt: new Date().toISOString(),
    project: cfg.url,
    userId,
    sessionExpiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
    otherProjectSessionsInProfile: otherProjectSessions,
    buckets: {
      'sales-brain': await listBucket(cfg, token, 'sales-brain', userId),
      attachments: await listBucket(cfg, token, 'attachments', userId)
    },
    tables: {}
  }
  for (const t of [
    'backup_rise_conversations',
    'backup_calls',
    'backup_contacts',
    'backup_knowledge',
    'backup_settings',
    'backup_objection_queue',
    'backup_deals',
    'backup_deal_stages'
  ]) {
    snapshot.tables[t] = await countRows(cfg, token, t, userId)
  }

  const text = JSON.stringify(snapshot, null, 2)

  // The leak assertion. A verification instrument that quietly printed the
  // founder's session token would be worse than no instrument. Checked
  // against the ACTUAL secret values, not a pattern that might not match.
  for (const [name, secret] of [
    ['access token', token],
    ['anon key', cfg.anon]
  ]) {
    if (text.includes(secret) || text.includes(secret.slice(0, 32))) {
      process.stderr.write(`REFUSING TO PRINT: the ${name} appears in the output\n`)
      app.exit(2)
      return
    }
  }

  process.stdout.write(text + '\n')
  const stable = text.replace(/"readAt": "[^"]+",/, '')
  process.stdout.write('digest(excluding readAt): ' + createHash('sha256').update(stable).digest('hex') + '\n')

  if (OUT_DIR) {
    mkdirSync(OUT_DIR, { recursive: true })
    const f = join(OUT_DIR, `cloud-${LABEL}-${snapshot.readAt.replace(/[:.]/g, '-')}.json`)
    writeFileSync(f, text, 'utf8')
    process.stdout.write('written: ' + f + '\n')
  }
  rmSync(SCRATCH, { recursive: true, force: true })
  app.exit(0)
}

// MUST run before the app is ready. Electron's OSCrypt initialises its
// app-bound key on startup from whatever userData is current at that moment;
// switching the path inside whenReady() was too late and decryption failed
// with a key this process had just minted for an empty profile. Same class of
// bug as every other "the setting was applied after the thing that reads it".
useScratchProfile()

app.whenReady().then(main)
