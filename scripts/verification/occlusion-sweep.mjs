#!/usr/bin/env node
// occlusion-sweep.mjs — find TEXT the user cannot read because something else
// is drawn on top of it.
//
// WHY THIS EXISTS. Two real bugs in this repo were exactly this and both
// survived review: BUG-158 (the Live Deal Intelligence panel mounted over the
// transcript) and BUG-165 (the coaching-cue rail drawn THROUGH transcript
// text at every window width below 1280). In both cases every element was
// inside the viewport and every layout probe reported the screen clean.
// **Bounds are not occupancy.** The only question that settles it is: at this
// text's centre, is the topmost element still this text?
//
// THE FALSE POSITIVE THIS SCRIPT EXISTS TO AVOID. A naive version of this
// flagged three elements on the Calls screen as "covered by <header>". They
// were not: they were partially scrolled past the top edge of a scrolling
// container. getBoundingClientRect does NOT clip to an overflow ancestor, so
// a half-scrolled row reports a rect whose centre lands in the window's drag
// strip, and elementFromPoint dutifully returns the header. Every candidate
// here is therefore checked against the visible box of each scrolling
// ancestor before it counts.
//
//   node scripts/verification/occlusion-sweep.mjs [--port 9333] [--width 1280]
//
// Exit 0 = nothing occluded, 1 = something is, 2 = no app.

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name)
  return i !== -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt
}
const PORT = arg('port', 9333)
const WIDTHS = process.argv.includes('--width') ? [arg('width', 1280)] : [1280, 1100, 900]

const PROBE = [
  '(function(){',
  '  var hits=[], nodes=document.querySelectorAll("*");',
  '  function visibleBox(el){',
  '    // Intersect the element rect with every scrolling ancestor viewport, so',
  '    // a row half-scrolled past a container edge is judged on the part that',
  '    // is ACTUALLY on screen — not on a rect that ignores the clip.',
  '    var r=el.getBoundingClientRect();',
  '    var box={l:r.left,t:r.top,rr:r.right,b:r.bottom};',
  '    var p=el.parentElement;',
  '    while(p){',
  '      var s=getComputedStyle(p);',
  '      if (s.overflowY!=="visible" || s.overflowX!=="visible"){',
  '        var pr=p.getBoundingClientRect();',
  '        box.l=Math.max(box.l,pr.left); box.t=Math.max(box.t,pr.top);',
  '        box.rr=Math.min(box.rr,pr.right); box.b=Math.min(box.b,pr.bottom);',
  '      }',
  '      p=p.parentElement;',
  '    }',
  '    box.l=Math.max(box.l,0); box.t=Math.max(box.t,0);',
  '    box.rr=Math.min(box.rr,innerWidth); box.b=Math.min(box.b,innerHeight);',
  '    return box;',
  '  }',
  '  for (var i=0;i<nodes.length;i++){',
  '    var e=nodes[i];',
  '    if (e.childElementCount!==0) continue;',
  '    var t=(e.textContent||"").trim();',
  '    if (t.length<8) continue;',
  '    var s=getComputedStyle(e);',
  '    if (s.visibility==="hidden"||s.opacity==="0"||s.display==="none") continue;',
  '    var b=visibleBox(e);',
  '    var w=b.rr-b.l, h=b.b-b.t;',
  '    if (w<24 || h<8) continue;   // nothing meaningfully on screen to cover',
  '    var cx=b.l+w/2, cy=b.t+h/2;',
  '    var top=document.elementFromPoint(cx,cy);',
  '    if (!top || top===e || e.contains(top) || top.contains(e)) continue;',
  '    var by=(top.textContent||"").trim().slice(0,34)||("<"+top.tagName.toLowerCase()+">");',
  '    hits.push(t.slice(0,44)+"   <<covered by>>   "+by);',
  '  }',
  '  var out=[], seen={};',
  '  for (var k=0;k<hits.length;k++){ if(!seen[hits[k]]){seen[hits[k]]=1; out.push(hits[k])} }',
  '  return JSON.stringify(out.slice(0,12));',
  '})()'
].join('\n')

const CLICK = [
  '(function(){',
  '  if (typeof window.__OCC_LABEL__ === "undefined") return "NO LABEL SET - refusing";',
  '  var label=window.__OCC_LABEL__, mode=window.__OCC_MODE__||"exact", n=window.__OCC_N__||0;',
  '  delete window.__OCC_LABEL__;',
  '  var all=[].slice.call(document.querySelectorAll(\'button, a, [role="button"]\'));',
  '  var hits=all.filter(function(x){',
  '    var t=(x.textContent||"").trim();',
  '    if (mode==="prefix") return t.indexOf(label)===0;',
  '    return t===label || x.getAttribute("aria-label")===label;',
  '  });',
  '  if (mode==="prefix"){',
  '    if (hits.length<=n) return "only "+hits.length+" rows";',
  '    hits[n].click(); return "clicked row "+n;',
  '  }',
  '  if (hits.length!==1) return "matched "+hits.length+" for \\""+label+"\\"";',
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
const send = (m, p = {}) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method: m, params: p }))
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + m)) } }, 20000)
  })
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    const p = pending.get(d.id)
    pending.delete(d.id)
    return d.error ? p.rej(new Error(d.error.message)) : p.res(d.result)
  }
}
await new Promise((r) => (ws.onopen = r))
const ev = async (e) =>
  (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function click(label, mode, n) {
  await ev(
    'window.__OCC_LABEL__=' + JSON.stringify(label) +
    ';window.__OCC_MODE__=' + JSON.stringify(mode || 'exact') +
    ';window.__OCC_N__=' + (n || 0)
  )
  return ev(CLICK)
}

// RED CHECK — plant a div that genuinely covers real text, and refuse to
// report unless the probe sees it. A sweep that cannot find a deliberate
// overlap has no business reporting zero.
await ev(`(function(){
  var host = document.createElement('div');
  host.id = '__occ_canary__';
  host.style.cssText = 'position:fixed;left:40px;top:200px;width:320px;height:60px;z-index:99999;background:#fff';
  host.textContent = 'canary overlay';
  var under = document.createElement('div');
  under.id = '__occ_under__';
  under.style.cssText = 'position:fixed;left:60px;top:215px;width:240px;height:24px;z-index:1';
  under.textContent = 'this sentence should be reported as covered';
  document.body.appendChild(under);
  document.body.appendChild(host);
  return 1
})()`)
await wait(300)
const canary = JSON.parse(await ev(PROBE))
const sawCanary = canary.some((h) => h.includes('this sentence should be reported'))
await ev(`(function(){
  var n=document.querySelectorAll('#__occ_canary__, #__occ_under__');
  for (var i=0;i<n.length;i++) n[i].remove();
  return 1
})()`)
const leftover = await ev(`document.querySelectorAll('#__occ_canary__, #__occ_under__').length`)
if (!sawCanary) {
  console.error('')
  console.error('REFUSING TO REPORT: the probe could not see a deliberately covered sentence.')
  ws.close()
  process.exit(3)
}
if (leftover !== 0) {
  console.error('REFUSING TO REPORT: could not clean up its own canary nodes')
  ws.close()
  process.exit(3)
}
console.log('red check — probe detects a deliberate overlap, and cleaned up: OK')
console.log('')

let total = 0
for (const w of WIDTHS) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: 816, deviceScaleFactor: 1, mobile: false })
  await wait(1100)
  console.log('--- ' + w + 'px ---')
  await click('Back')
  await wait(700)
  for (const s of ['Home', 'Calls', 'Pipeline', 'Coaching', 'Library', 'Rise']) {
    const nav = await click(s)
    await wait(1700)
    const hits = JSON.parse(await ev(PROBE))
    total += hits.length
    const ok = String(nav).indexOf('clicked') === 0
    console.log('  ' + (ok ? '' : 'SKIP ') + s.padEnd(12) + 'occluded: ' + hits.length)
    for (const h of hits) console.log('        ! ' + h)
  }
  const nav = await click('Call ·', 'prefix', 0)
  await wait(1900)
  const hits = JSON.parse(await ev(PROBE))
  total += hits.length
  console.log('  ' + (String(nav).indexOf('clicked') === 0 ? '' : 'SKIP ') + 'Call detail'.padEnd(12) + 'occluded: ' + hits.length)
  for (const h of hits) console.log('        ! ' + h)
}
await send('Emulation.clearDeviceMetricsOverride')
await wait(900)
console.log('')
console.log('viewport restored: ' + (await ev('innerWidth + "x" + innerHeight')))
console.log('TOTAL occluded text elements: ' + total)
ws.close()
process.exit(total > 0 ? 1 : 0)
