// BUG-263 — WHAT ACTUALLY ESCAPES THE GUARD.
//
// The interceptor tests prove the patch refuses what it sees. They cannot prove
// it SEES everything, because that depends on whether each real client resolves
// `fetch`/`https.request` at call time or captured a reference when its module
// was first loaded — and which libraries do that is an empirical question that
// changes with every dependency bump.
//
// So this drives each client the way the app drives it, at a host the guard is
// configured to refuse, and counts. A client that throws SandboxEgressRefused
// is GATED. A client whose request goes out is an ESCAPE, and an escape needs a
// call-site gate, named in the tracker row as such.
//
// NOTHING HERE SENDS A REAL PAYLOAD AND NOTHING USES A REAL KEY. Every request
// is built with an obviously-fake credential and aimed at an endpoint that will
// reject it; the only outcome being measured is whether the request LEFT, which
// is visible from the error it comes back with. A request that escapes reaches
// a provider's auth check and stops there.
//
// usage: node scripts/verification/bug263-egress-canary.mjs
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = process.cwd()

// The guard is TypeScript; load it through tsx's loader the same way the other
// verification scripts do.
const { installSandboxEgressGuard, sandboxRefusals, SandboxEgressRefused } = await import(
  pathToFileURL(join(ROOT, 'src', 'main', 'sandbox-egress.ts')).href
)

// Grant nothing: every category below must be refused.
installSandboxEgressGuard(new Set())

const FAKE_KEY = ['sk', 'canary', 'not', 'a', 'real', 'key'].join('-')

class ModuleMissing extends Error {}
/** A dependency that is not installed is NOT an escape — it is a probe that
 *  never ran. Reporting it as an escape overstates the danger; reporting it as
 *  gated overstates the protection. It gets its own verdict. */
function requireOrSkip(name) {
  try {
    return require(name)
  } catch (err) {
    if (err?.code === 'MODULE_NOT_FOUND') throw new ModuleMissing(name)
    throw err
  }
}

/** Did this attempt get stopped by the guard, or did it leave? */
async function probe(name, category, run) {
  const before = sandboxRefusals().length
  let threw = null
  try {
    await run()
  } catch (err) {
    threw = err
  }
  if (threw instanceof ModuleMissing) {
    return { name, category, verdict: 'SKIPPED', error: `not installed: ${threw.message}` }
  }
  const refused = sandboxRefusals().length > before
  const named =
    threw instanceof SandboxEgressRefused ||
    (threw && String(threw?.cause?.name ?? threw?.name) === 'SandboxEgressRefused') ||
    (threw && /SANDBOX egress REFUSED/.test(String(threw?.message ?? '')))
  return {
    name,
    category,
    verdict: refused || named ? 'GATED' : 'ESCAPED',
    error: threw && String(threw.message ?? threw).slice(0, 120)
  }
}

// ── SELF-CHECK ─────────────────────────────────────────────────────────────
// "0 escaped" is only worth reading if this script can SAY escaped. Two
// synthetic probes prove the verdict logic can produce each answer, without
// sending anything anywhere: one that fails the way an ungated client fails
// (a plain network error, no refusal recorded), and one that is refused.
//
// Doing it this way rather than by granting a category and watching a real
// request leave: that would prove the same thing by actually contacting six
// third-party services, which is a strange way to test an egress guard.
const selfEscape = await probe('SELF-CHECK must read ESCAPED', 'ai', async () => {
  throw new Error('ECONNREFUSED (simulated ungated client)')
})
const selfGated = await probe('SELF-CHECK must read GATED', 'ai', () =>
  fetch('https://api.openai.com/v1/models')
)
if (selfEscape.verdict !== 'ESCAPED' || selfGated.verdict !== 'GATED') {
  console.error('SELF-CHECK FAILED — this script cannot tell the two apart:')
  console.error(`  expected ESCAPED, got ${selfEscape.verdict}`)
  console.error(`  expected GATED,   got ${selfGated.verdict}`)
  console.error('Every result below would be meaningless. Fix the probe first.')
  process.exit(2)
}

const results = []

// 1. Plain global fetch — the baseline. If this escapes, nothing else matters.
results.push(
  await probe('global fetch', 'calendar', () => fetch('https://graph.microsoft.com/v1.0/me/events'))
)

// 2. Anthropic SDK.
results.push(
  await probe('@anthropic-ai/sdk', 'ai', async () => {
    const Anthropic = require('@anthropic-ai/sdk').default ?? require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: FAKE_KEY, maxRetries: 0 })
    await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'canary' }]
    })
  })
)

// 3. OpenAI SDK (also the path every openai-compatible provider takes).
results.push(
  await probe('openai', 'ai', async () => {
    const OpenAI = require('openai').default ?? require('openai')
    const client = new OpenAI({ apiKey: FAKE_KEY, maxRetries: 0 })
    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'canary' }]
    })
  })
)

// 4. supabase-js — the client the cloud backup uses.
results.push(
  await probe('@supabase/supabase-js', 'sync', async () => {
    const { createClient } = require('@supabase/supabase-js')
    const client = createClient('https://canary-project.supabase.co', FAKE_KEY)
    const { error } = await client.from('calls').select('id').limit(1)
    if (error) throw new Error(error.message)
  })
)

// 5. ws — the Deepgram live-audio socket. This is the one the http/https patch
//    is supposed to catch indirectly, through the upgrade handshake.
results.push(
  await probe('ws (Deepgram socket)', 'transcription', async () => {
    const WebSocket = require('ws')
    await new Promise((resolve, reject) => {
      let sock
      try {
        sock = new WebSocket('wss://api.deepgram.com/v1/listen', {
          headers: { Authorization: `Token ${FAKE_KEY}` }
        })
      } catch (err) {
        reject(err)
        return
      }
      sock.on('open', () => {
        sock.close()
        resolve()
      })
      sock.on('error', reject)
      setTimeout(() => {
        try {
          sock.close()
        } catch {
          /* ignore */
        }
        reject(new Error('timed out with no error and no open — treat as ESCAPED'))
      }, 8000)
    })
  })
)

// 6. google-auth-library's OAuth2Client — the Google Calendar client.
//    NOT `googleapis`: this app does not depend on it, and the first version of
//    this canary required it, caught `Cannot find module`, and printed ESCAPED.
//    A missing module and an ungated request produce the same "it threw
//    something that isn't our error" evidence, which is the mechanism-vs-
//    population confusion in a new costume. Hence `requireOrSkip`.
results.push(
  await probe('google-auth-library (calendar)', 'calendar', async () => {
    const { OAuth2Client } = requireOrSkip('google-auth-library')
    const auth = new OAuth2Client('id', 'secret', 'http://localhost:1')
    auth.setCredentials({ access_token: FAKE_KEY })
    await auth.request({ url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList' })
  })
)

const gated = results.filter((r) => r.verdict === 'GATED')
const escaped = results.filter((r) => r.verdict === 'ESCAPED')
const skipped = results.filter((r) => r.verdict === 'SKIPPED')

console.log('')
console.log('BUG-263 canary — every client driven at a host the guard refuses')
console.log('='.repeat(72))
for (const r of results) {
  console.log(`${r.verdict.padEnd(8)} ${r.name.padEnd(30)} (${r.category})`)
  if (r.verdict !== 'GATED') console.log(`         ${r.error}`)
}
console.log('='.repeat(72))
console.log(
  `GATED ${gated.length}  |  ESCAPED ${escaped.length}  |  SKIPPED ${skipped.length}  ` +
    `(of ${results.length} probes)`
)
console.log(`refusals recorded by the guard: ${sandboxRefusals().length}`)
if (escaped.length) {
  console.log('')
  console.log('Each ESCAPE needs a call-site gate: interception did not reach it, which')
  console.log('means the client captured fetch/https before the patch was installed.')
}
if (skipped.length) {
  console.log('')
  console.log('A SKIPPED probe proves NOTHING either way — the dependency is absent, so')
  console.log('that path was never exercised. It is not counted as protection.')
}
process.exit(0)
