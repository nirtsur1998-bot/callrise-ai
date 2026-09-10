// BUG-225 — the checks themselves, against an app that is ALREADY running.
//
// Split from the launcher so the two failures stay separable: "the app would
// not start" and "the feature does not work" are different findings, and a
// script that does both reports the first as the second.
//
// It deliberately does NOT use ui-driver's `openApp`: a fresh sandbox profile
// opens on the login screen, which is 167 characters, and openApp's readiness
// gate wants 200 — it reports a perfectly painted app as never painted. See
// README, "openApp calls a fully-painted login screen 'never painted'".
// `window.api` comes from preload, so being signed out changes nothing here.
//
// usage:
//   1. launch a sandboxed dev app (its own profile AND its own port — the
//      single-instance lock is keyed on the profile path):
//        CALLRISE_USER_DATA_DIR=/tmp/bug225 npx electron-vite dev -- --remote-debugging-port=9341
//      Wait for BOTH lines: "[dev] userData overridden ->" and "[dev] SANDBOX
//      profile at ... REFUSED". Without them you are driving the real profile.
//   2. node scripts/verification/bug225-checks.mjs /tmp/bug225 9341
//   3. node scripts/verification/cue-latency-report.mjs /tmp/bug225
//   4. kill the TREE when done: taskkill /T /F /PID <pid>  (see README)
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from './cdp.mjs'
import { pidOwningPort } from './ui-driver.mjs'

const SANDBOX = process.argv[2]
const PORT = Number(process.argv[3] || 9341)
if (!SANDBOX) throw new Error('usage: bug225-checks.mjs <sandboxUserDataDir> [port]')
const LOG = join(SANDBOX, 'cue-latency.jsonl')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const lines = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : [])

console.log(`[bug225] port ${PORT} owned by PID ${pidOwningPort(PORT)}`)
const cdp = await connect(PORT)
console.log(`[bug225] page: ${cdp.page.url}`)
const send = (js) => cdp.evaluate(js)

// The renderer is on the LOGIN screen with a fresh sandbox profile, which is
// fine and is the point: `window.api` comes from preload, not from being
// signed in. Worth saying out loud because ui-driver's readiness gate
// ("body text > 200 chars") calls this fully-painted screen unpainted — it is
// 167 characters. That is a threshold artefact, not a broken app.
check('the renderer really is this launch’s sandbox app', cdp.page.url.includes('localhost:'), cdp.page.url)

// 1. THE BRIDGE IS REAL. contextBridge objects are frozen, so asking the live
//    renderer is the only honest way to know what is actually exposed.
const bridge = await send('typeof window.api?.live?.recordCueLatency')
check('preload exposes window.api.live.recordCueLatency', bridge === 'function', `typeof = ${bridge}`)

check('no log exists before anything is recorded', !existsSync(LOG), `${lines().length} line(s)`)

// 2. A REAL FLUSH through the real main handler onto a real disk.
await send(
  `window.api.live.recordCueLatency({ callId: 'drive-call-A', samples: { deterministic: [380, 410, 445], model: [1900, 2400] } })`
)
await sleep(1500)
const afterFirst = lines()
check('one line written for the call', afterFirst.length === 1, `${afterFirst.length} line(s)`)
const first = afterFirst[0] ? JSON.parse(afterFirst[0]) : { samples: {} }
check(
  'the samples survived the IPC boundary intact',
  JSON.stringify(first.samples.deterministic) === '[380,410,445]' &&
    JSON.stringify(first.samples.model) === '[1900,2400]',
  JSON.stringify(first.samples)
)
check('the main process stamped a timestamp', typeof first.ts === 'string' && first.ts.length > 10, first.ts)

// 3. THE MERGE on a real file. A capture blip flushes a call twice; two lines
//    would count one call as two, and `calls` is the denominator a reader uses.
await send(
  `window.api.live.recordCueLatency({ callId: 'drive-call-A', samples: { deterministic: [395], model: [] } })`
)
await sleep(1500)
const afterMerge = lines()
check('a second flush of the same call added no line', afterMerge.length === 1, `${afterMerge.length} line(s)`)
const merged = JSON.parse(afterMerge[0] ?? '{"samples":{},"ts":null}')
check(
  'the second flush merged into the first',
  JSON.stringify(merged.samples.deterministic) === '[380,410,445,395]',
  JSON.stringify(merged.samples.deterministic)
)
check('the merged line kept the call’s FIRST timestamp', merged.ts === first.ts, `${first.ts} -> ${merged.ts}`)

// 4. A different call is a different line.
await send(
  `window.api.live.recordCueLatency({ callId: 'drive-call-B', samples: { deterministic: [], model: [2100, 9800] } })`
)
await sleep(1500)
check('a different call started a new line', lines().length === 2, `${lines().length} line(s)`)

// 5. THE BOUNDARY IS NOT TRUSTED. This is the REAL handler, not the unit
//    test's — the renderer is where a compromised page would push from.
await send(
  `window.api.live.recordCueLatency({ callId: 'x'.repeat(500), samples: { deterministic: [100, -5, null, 'NaNish', 1e400, 200], model: 'not-an-array' } })`
)
await sleep(1500)
const all = lines()
const poisoned = JSON.parse(all[all.length - 1] ?? '{"samples":{}}')
check('an over-long callId was refused, not stored', poisoned.callId === null, String(poisoned.callId).slice(0, 24))
check(
  'nonsense samples were dropped, not left to poison a percentile',
  JSON.stringify(poisoned.samples.deterministic) === '[100,200]' &&
    JSON.stringify(poisoned.samples.model) === '[]',
  JSON.stringify(poisoned.samples)
)

// 6. A call with no cues writes nothing.
const before = readFileSync(LOG, 'utf8')
await send(
  `window.api.live.recordCueLatency({ callId: 'drive-call-empty', samples: { deterministic: [], model: [] } })`
)
await sleep(1500)
check('a call that produced no cues added no line', readFileSync(LOG, 'utf8') === before)

// 7. THE WORK COUNT. Several checks above are satisfied by producing nothing,
//    and "produced no X" is indistinguishable from "never executed" without a
//    count of the work that was actually done.
const totalSamples = lines()
  .map((l) => JSON.parse(l))
  .reduce((n, e) => n + e.samples.deterministic.length + e.samples.model.length, 0)
check(
  'the handler actually ran: samples were recorded',
  totalSamples >= 8,
  `${totalSamples} samples across ${lines().length} lines`
)

console.log('')
const failed = results.filter((r) => !r.pass)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
