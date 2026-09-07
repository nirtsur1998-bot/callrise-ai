/**
 * What can a holder of the SHIPPED ANON KEY alone reach?
 *
 * The anon key is embedded in the packaged app and is extractable in seconds,
 * so "reachable with the anon key and no user session" is the real threat
 * model for anything in this project. This probe answers it with the key only
 * — no user token, no session — and it is STRICTLY READ-ONLY:
 *
 *   - GET  /rest/v1/            the OpenAPI document PostgREST generates FOR
 *                               THE CALLING ROLE. A function appears in
 *                               `paths` as /rpc/<name> only if that role has
 *                               EXECUTE on it, so this answers "can anon call
 *                               it" without calling it.
 *   - GET  /rest/v1/<table>     a bare select, limit 0.
 *
 * It never POSTs, never calls an RPC, and never touches a mutating endpoint.
 * `claim_due_deliveries` in particular MUTATES (it claims rows), so it is
 * listed and never invoked.
 *
 * Prints no key. The output is asserted against the key before anything is
 * written.
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const REPO = join(__dirname, '..', '..')

function config() {
  const src = readFileSync(join(REPO, 'src', 'main', 'default-config.ts'), 'utf8')
  const url = /SUPABASE_URL:\s*'([^']+)'/.exec(src)
  const anon = /SUPABASE_ANON_KEY:\s*'([^']+)'/.exec(src)
  if (!url || !anon) {
    process.stderr.write('FAILED: could not read the project config\n')
    process.exit(1)
  }
  return { url: url[1], anon: anon[1] }
}

async function main() {
  const cfg = config()
  const H = { apikey: cfg.anon, Authorization: `Bearer ${cfg.anon}` }

  const out = { project: cfg.url, role: 'anon (no user session)', rpcs: [], tables: {}, notes: [] }

  const res = await fetch(`${cfg.url}/rest/v1/`, { headers: H })
  if (!res.ok) {
    out.notes.push(`the OpenAPI document is not served to anon (${res.status})`)
  } else {
    const doc = await res.json()
    const paths = Object.keys(doc.paths || {})
    out.rpcs = paths.filter((p) => p.startsWith('/rpc/')).map((p) => p.slice(5)).sort()
    out.notes.push(
      `PostgREST lists a function under /rpc only when the CALLING role has EXECUTE on it, ` +
        `so this list is what the anon key can invoke. ${paths.length} paths total.`
    )
  }

  // A bare select on the tables that matter, limit 0 — no rows requested.
  for (const t of [
    'backup_events',
    'backup_tasks',
    'backup_calls',
    'backup_rise_conversations',
    'notification_channels',
    'alert_deliveries'
  ]) {
    const r = await fetch(`${cfg.url}/rest/v1/${t}?select=user_id&limit=0`, { headers: H })
    const body = await r.text()
    out.tables[t] = { status: r.status, body: body.slice(0, 160) }
  }

  // Does the function EXIST and can anon see it? A GET never executes a
  // VOLATILE function: PostgREST answers 404 when the function is absent and
  // 405 when it exists but is not GET-able. So this distinguishes the two
  // without invoking anything. claim_due_deliveries MUTATES and is never
  // called here.
  out.functions = {}
  for (const fn of [
    'claim_due_deliveries',
    'derive_meeting_alerts',
    'server_now',
    'mark_delivery_sent'
  ]) {
    const r = await fetch(cfg.url + '/rest/v1/rpc/' + fn, { headers: H })
    const body = await r.text()
    out.functions[fn] = {
      status: r.status,
      meaning:
        r.status === 404
          ? 'DOES NOT EXIST on this project (or anon cannot see it)'
          : r.status === 405
            ? 'EXISTS and anon can reach it (GET refused, but it resolved)'
            : 'see body',
      body: body.slice(0, 140)
    }
  }

  const text = JSON.stringify(out, null, 2)
  if (text.includes(cfg.anon) || text.includes(cfg.anon.slice(0, 32))) {
    process.stderr.write('REFUSING TO PRINT: the anon key appears in the output\n')
    process.exit(2)
  }
  process.stdout.write(text + '\n')
}

main().catch((e) => {
  process.stderr.write('FAILED: ' + e.message + '\n')
  process.exit(1)
})
