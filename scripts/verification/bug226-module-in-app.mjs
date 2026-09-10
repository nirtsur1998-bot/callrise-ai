// BUG-226 — execute the SHIPPED matcher inside the running renderer, against
// events loaded through the app's own IPC.
//
// WHY NOT THE LIVE SCREEN. `currentMeeting` only exists while LiveView is
// mounted, and LiveView is the recording screen — reaching it means starting a
// microphone capture on the founder's machine. That is not something to do
// unasked, so this proves the next-best thing and says so plainly:
//
//   PROVEN HERE: the real module, loaded by the real renderer from the real
//   dev server, deciding over events fetched through the real `events.list()`
//   IPC out of a real profile on disk.
//   NOT PROVEN HERE: that LiveView renders the result. That is covered by the
//   import + call site in LiveView.tsx and by matchLiveMeeting.test.ts, and it
//   is the piece a live call would add.
//
// Vite serves the renderer's TypeScript directly in dev, so `import()` from the
// page executes the actual source file — not a copy, and not a re-implementation
// in this script, which would prove nothing about what ships.
//
// usage: node scripts/verification/bug226-module-in-app.mjs [port]
import { connect } from './cdp.mjs'

const PORT = Number(process.argv[2] || 9342)
const cdp = await connect(PORT)
console.log(`[bug226] page: ${cdp.page.url}`)

const CANDIDATE_PATHS = [
  '/src/features/live/matchLiveMeeting.ts',
  '/src/renderer/src/features/live/matchLiveMeeting.ts',
  './features/live/matchLiveMeeting.ts'
]

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. Load the REAL module in the page.
let modPath = null
for (const p of CANDIDATE_PATHS) {
  const ok = await cdp.evaluate(
    `import(${JSON.stringify(p)}).then(m => typeof m.matchLiveMeeting).catch(e => 'ERR:' + e.message)`
  )
  if (ok === 'function') {
    modPath = p
    break
  }
}
check('the renderer can load the shipped matchLiveMeeting module', modPath !== null, modPath ?? 'no path resolved')
if (!modPath) process.exit(1)

// 2. Events come from the app's own IPC, not from this script.
const events = await cdp.evaluate('window.api.events.list().then(e => JSON.stringify(e))')
const parsed = JSON.parse(events)
const planted = parsed.filter((e) => String(e.title ?? '').startsWith('ZZ-BUG226'))
check('the app loaded the planted events through its own IPC', planted.length >= 2, `${planted.length} of ${parsed.length} events`)

// 3. THE CLAIM: two meetings tied on every signal resolve to NOTHING.
const verdict = JSON.parse(
  await cdp.evaluate(`import(${JSON.stringify(modPath)}).then(async (m) => {
    const all = await window.api.events.list()
    const r = m.matchLiveMeeting(all, Date.now())
    return JSON.stringify({ reason: r.reason, candidates: r.candidates, title: r.meeting ? r.meeting.title : null })
  })`)
)
console.log(`  [verdict] ${JSON.stringify(verdict)}`)

const scenario = process.env.BUG226_SCENARIO ?? 'ambiguous'
if (scenario === 'ambiguous') {
  // `meeting` itself is not serialised across CDP — only its title is, so the
  // assertion has to be on the title. Asserting on `verdict.meeting` read
  // `undefined === null` and failed a correct result.
  check('two indistinguishable meetings resolve to NO meeting', verdict.title === null, `title=${verdict.title}`)
  check('and it says WHY — ambiguous, not an empty calendar', verdict.reason === 'ambiguous', verdict.reason)
  check('the work count: it really did consider both', verdict.candidates === 2, `candidates=${verdict.candidates}`)
} else {
  check('the hand-linked meeting wins', verdict.title === 'ZZ-BUG226-LINKED', String(verdict.title))
  check('it ranked rather than fell through to a single candidate', verdict.reason === 'ranked', verdict.reason)
  check('the work count: it really did consider both', verdict.candidates === 2, `candidates=${verdict.candidates}`)
}

// 4. ORDER INDEPENDENCE — the actual defect. The old code returned whichever
//    feed loaded first; the same events reversed must give the same answer.
const reversed = JSON.parse(
  await cdp.evaluate(`import(${JSON.stringify(modPath)}).then(async (m) => {
    const all = (await window.api.events.list()).slice().reverse()
    const r = m.matchLiveMeeting(all, Date.now())
    return JSON.stringify({ reason: r.reason, title: r.meeting ? r.meeting.title : null })
  })`)
)
check(
  'the answer does not change when the feeds arrive in the other order',
  reversed.title === verdict.title && reversed.reason === verdict.reason,
  `${JSON.stringify(verdict)} vs ${JSON.stringify(reversed)}`
)

console.log('')
const failed = results.filter((r) => !r.pass)
console.log(`${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
