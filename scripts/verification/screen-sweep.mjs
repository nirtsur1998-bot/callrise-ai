#!/usr/bin/env node
// screen-sweep.mjs — walk every screen and detail page of a running build and
// report two things per screen: text that should never be visible to a user
// (a raw `null`, `undefined`, `NaN`, `[object Object]`, an unrendered
// template) and any console error or exception.
//
// WHY THIS EXISTS. BUG-163 — a contact literally named "null", auto-created
// and auto-linked to nineteen calls — was found by LOOKING at a screenshot
// taken to check something else entirely. Every automated probe in that
// session had reported success, because each one asked a narrower question
// than "does this screen look right". This script asks the broad question.
//
// THE RULE IT ENFORCES. Both instruments RED-CHECK themselves before they are
// believed, and the script REFUSES to report rather than return a zero it has
// not earned — a probe reporting nothing is a claim about the probe until
// proven otherwise (taxonomy species 66). The text probe plants five known
// defects and three innocent lookalikes ("Cannula", "Annulment", "Nunes",
// which a substring match would eat) and must catch exactly the five. The
// console hook must see a planted console.error.
//
// It only ever READS. It clicks navigation, and nothing that writes.
//
//   node scripts/verification/screen-sweep.mjs [--port 9333]

const PORT = (() => {
  const i = process.argv.indexOf('--port')
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 9333
})()

// Leaves only — a parent's joined textContent invents hits that are not on
// screen as a single string. WHOLE words only, never substrings: "Cannula",
// "Annulment" and "Nunes Holdings" are real things a user could have typed,
// and a substring match would silently flag (or, in a fix, delete) them.
const DEFECT_PROBE = [
  '(function(){',
  '  var bad=[], nodes=document.querySelectorAll("*");',
  '  for (var i=0;i<nodes.length;i++){',
  '    var e=nodes[i];',
  '    if (e.childElementCount!==0) continue;',
  '    var t=(e.textContent||"").trim();',
  '    if (!t || t.length>160) continue;',
  '    var hit=null, words=t.split(/[^A-Za-z0-9_$]+/);',
  '    for (var j=0;j<words.length;j++){',
  '      var w=words[j];',
  '      if (w==="null"||w==="undefined"||w==="NaN"||w==="Infinity"){ hit=w; break }',
  '    }',
  '    if (!hit && t.indexOf("[object")!==-1) hit="[object Object]";',
  '    if (!hit && (t.indexOf("{{")!==-1 || t.indexOf("${")!==-1)) hit="unrendered template";',
  '    if (hit) bad.push(hit+" :: "+t.slice(0,90));',
  '  }',
  '  var out=[], seen={};',
  '  for (var k=0;k<bad.length;k++){ if(!seen[bad[k]]){seen[bad[k]]=1; out.push(bad[k])} }',
  '  return JSON.stringify(out);',
  '})()'
].join('\n')

// Refuses on an ambiguous match rather than clicking the first thing that
// looks right — species 53, and the reason the README opens the way it does.
const CLICK = [
  '(function(){',
  '  var label=window.__SWEEP_LABEL__, mode=window.__SWEEP_MODE__, n=window.__SWEEP_N__||0;',
  '  var all=[].slice.call(document.querySelectorAll(\'button, a, [role="button"]\'));',
  '  var hits=all.filter(function(x){',
  '    var t=(x.textContent||"").trim();',
  '    if (mode==="prefix") return t.indexOf(label)===0;',
  '    return t===label || x.getAttribute("aria-label")===label;',
  '  });',
  '  if (mode==="prefix"){',
  '    if (hits.length<=n) return "only "+hits.length+" rows";',
  '    hits[n].click(); return "clicked row "+n+" of "+hits.length;',
  '  }',
  '  if (hits.length!==1) return "matched "+hits.length;',
  '  hits[0].click(); return "clicked";',
  '})()'
].join('\n')

const targets = await (await fetch('http://localhost:' + PORT + '/json/list')).json()
const page = targets.find((t) => t.type === 'page' && !String(t.url).includes('detection-overlay'))
if (!page) {
  console.error('No main page target on port ' + PORT + '. Is the app running with remote debugging?')
  process.exit(2)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
let bucket = []
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
    setTimeout(() => {
      if (pending.has(i)) {
        pending.delete(i)
        rej(new Error('timeout ' + m))
      }
    }, 20000)
  })
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    const p = pending.get(d.id)
    pending.delete(d.id)
    return d.error ? p.rej(new Error(d.error.message)) : p.res(d.result)
  }
  if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) {
    bucket.push(
      d.params.type +
        ': ' +
        (d.params.args || [])
          .map((a) => a.value ?? a.description ?? a.type)
          .join(' ')
          .slice(0, 150)
    )
  }
  if (d.method === 'Runtime.exceptionThrown') {
    const e = d.params.exceptionDetails
    bucket.push('EXCEPTION: ' + String(e?.exception?.description || e?.text || '').slice(0, 180))
  }
}
await new Promise((r) => (ws.onopen = r))
const ev = async (e) =>
  (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result
    .value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const refuse = (why) => {
  console.error('')
  console.error('REFUSING TO REPORT: ' + why)
  ws.close()
  process.exit(3)
}

// ---- red check 1: the console hook ------------------------------------------
await send('Runtime.enable')
await ev('console.error("__sweep_canary__")')
await wait(500)
if (!bucket.some((b) => b.includes('__sweep_canary__'))) {
  refuse('the console hook never saw a planted console.error, so its silence means nothing')
}
console.log('red check — console hook sees a planted error: OK')
bucket = []

// ---- red check 2: the text probe --------------------------------------------
// Cleanup uses querySelectorAll, NOT getElementById: a crashed earlier run can
// leave a second node with the same id and getElementById returns only the
// first. That exact leak once made this red check report 6 hits instead of 5.
const PLANTED = ['null', 'undefined', 'NaN', '[object Object]', 'Total: {{count}}']
const INNOCENT = ['Cannula supplier', 'Annulment notes', 'Nunes Holdings']
await ev(
  '(function(){var d=document.createElement("div");d.id="__sweep_canary__";' +
    'var all=' +
    JSON.stringify(PLANTED.concat(INNOCENT)) +
    ';for(var i=0;i<all.length;i++){var s=document.createElement("span");s.textContent=all[i];d.appendChild(s)}' +
    'document.body.appendChild(d);return 1})()'
)
const canaryHits = JSON.parse(await ev(DEFECT_PROBE))
const falsePositives = canaryHits.filter((h) => /Cannula|Annulment|Nunes/.test(h))
await ev(
  '(function(){var n=document.querySelectorAll("#__sweep_canary__");for(var i=0;i<n.length;i++)n[i].remove();return 1})()'
)
const leftover = await ev('document.querySelectorAll("#__sweep_canary__").length')
if (canaryHits.length !== PLANTED.length) {
  refuse('text probe caught ' + canaryHits.length + ' of ' + PLANTED.length + ' planted defects')
}
if (falsePositives.length) {
  refuse('text probe flagged an innocent lookalike: ' + falsePositives.join(', '))
}
if (leftover !== 0) refuse('could not clean up its own canary nodes (' + leftover + ' left behind)')
console.log('red check — text probe: 5/5 planted caught, 0 false positives, cleaned up: OK')
console.log('')

async function click(label, mode, n) {
  await ev(
    'window.__SWEEP_LABEL__=' +
      JSON.stringify(label) +
      ';window.__SWEEP_MODE__=' +
      JSON.stringify(mode || 'exact') +
      ';window.__SWEEP_N__=' +
      (n || 0)
  )
  return ev(CLICK)
}

let defects = 0
let consoleHits = 0
let visited = 0
const skipped = []
async function visit(label, nav) {
  await wait(2200)
  const ok = String(nav).indexOf('clicked') === 0
  ok ? visited++ : skipped.push(label + ' — ' + nav)
  const found = JSON.parse(await ev(DEFECT_PROBE))
  const logs = [...new Set(bucket)]
  bucket = []
  defects += found.length
  consoleHits += logs.length
  console.log(
    (ok ? '  ' : '  SKIP ') + label.padEnd(28) + 'defects: ' + found.length + '  console: ' + logs.length
  )
  for (const f of found) console.log('        TEXT    ! ' + f)
  for (const l of logs) console.log('        CONSOLE ! ' + l)
}

// Settings replaces the whole sidebar with its own menu, so a sweep that
// starts (or ends) there will "match 0" on every nav item and report a
// meaningless row of zeros. Leave it first, every time.
await click('Back')
await wait(800)
bucket = []

console.log('--- screens and detail pages ---')
await visit('Calls list', await click('Calls'))
await visit('Call detail (newest)', await click('Call ·', 'prefix', 0))
await click('Calls')
await wait(1000)
bucket = []
await visit('Call detail (4th)', await click('Call ·', 'prefix', 3))
for (const s of ['Pipeline', 'Coaching', 'Library', 'Rise', 'Home']) await visit(s, await click(s))

console.log('--- settings sub-pages ---')
await click('Settings')
await wait(1500)
bucket = []
const SUBPAGES = [
  'Account', 'Recording & consent', 'Call detection', 'Notes & summaries', 'Audio',
  'Coaching', 'Deal risk during calls', 'Objection Library', 'API keys',
  'Which model does what', 'About you', 'What CallRise remembers', 'Calendar',
  'Contact matching', 'Appearance', 'General', 'Privacy & data', 'Crash reports',
  'Background jobs'
]
for (const s of SUBPAGES) {
  await visit(s, await click(s))
  await click('Back')
  await wait(600)
  if (String(await ev('(document.body.innerText||"").indexOf("CONNECTIONS")')) === '-1') {
    await click('Settings')
    await wait(1100)
  }
  bucket = []
}

console.log('')
console.log('states visited : ' + visited + (skipped.length ? '  (skipped ' + skipped.length + ')' : ''))
for (const s of skipped) console.log('   skipped: ' + s)
console.log('visible defects: ' + defects)
console.log('console errors : ' + consoleHits)
ws.close()
process.exit(defects + consoleHits > 0 ? 1 : 0)
