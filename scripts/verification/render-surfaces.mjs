// Render M32 Stage 2's surfaces in the REAL running app — real stylesheet,
// real theme tokens, real preload bridge, real data — without a session, by
// importing the components through the Vite dev module server the app is
// already running against.
//
// WHAT THIS IS AND IS NOT. A real render of the shipped components in the
// app's own environment: a wrong token, a bad wrap, a row whose buttons
// collapse all show up here. It is NOT the full end-to-end pass — the
// components are mounted directly rather than reached by navigating a
// signed-in app, so it says nothing about whether DealsView places them
// correctly. Stated in the report rather than glossed.
//
// The backfill dialog is the interesting one: it calls
// `window.api.dealBackfill.state()` itself, which is main-process and needs no
// auth, so it renders with REAL rows out of the sandbox copy of the data.
//
// NO REGEX LITERALS, NO `?.`, NO `??` inside evaluated strings. All three get
// mangled passing through template literal -> CDP, and the failure is silent:
// a stripped regex still parses and matches the wrong thing.
import { connect } from 'file:///C:/Users/User/Desktop/callrise-m32/scripts/verification/cdp.mjs'

const SHOTS =
  'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-CALLRISE-AI/775b4c37-5eaf-43f1-b11d-89700fb629fd/scratchpad/shots'
const NL = String.fromCharCode(10)

const cdp = await connect(9333)
const pageUrl = cdp.page.url
if (pageUrl.indexOf('app.asar') !== -1) {
  throw new Error('refusing: this is the PACKAGED app, not the dev build: ' + pageUrl)
}
console.log('[render] dev build: ' + pageUrl)

async function ev(expr) {
  const r = await cdp.evaluate(expr)
  if (r && typeof r === 'object' && r.__err) throw new Error(r.__err)
  return r
}

// Resolve React and ReactDOM off Vite's pre-bundled dep URLs, discovered from
// the entry module so the ?v= build hash cannot go stale. Both are CJS-interop
// modules here, so the real namespace is under `.default`.
const PREAMBLE = `
  const entry = await (await fetch('/src/main.tsx')).text()
  const findUrl = function (needle) {
    const i = entry.indexOf(needle)
    if (i === -1) throw new Error('dep url not found for ' + needle)
    const q = String.fromCharCode(34)
    return entry.slice(entry.lastIndexOf(q, i) + 1, entry.indexOf(q, i))
  }
  const rmod = await import(findUrl('/deps/react.js'))
  const React = rmod.default || rmod
  const dmod = await import(findUrl('/deps/react-dom_client.js'))
  const RD = dmod.default || dmod
  const createRoot = RD.createRoot
  const h = React.createElement
  if (typeof h !== 'function') throw new Error('createElement missing')
  if (typeof createRoot !== 'function') throw new Error('createRoot missing')
`

async function mount(name, buildBody) {
  const out = await ev(`(async () => {
    try {
      ${PREAMBLE}
      // BASELINE FIRST. The body-text fallback below (needed because Modal
      // portals out of the host) turned a blank render into a PASS on its
      // first outing: the login screen underneath is ~90 chars, over the
      // refuse threshold, so a host that rendered nothing still screenshotted.
      // A length check cannot tell "my component" from "whatever was already
      // on screen" — only a comparison against the before-state can.
      const baseline = document.body.innerText || ''
      if (window.__m32root) {
        try { window.__m32root.unmount() } catch (e) { /* already gone */ }
        window.__m32root = null
      }
      const old = document.getElementById('m32-probe')
      if (old) old.remove()
      const host = document.createElement('div')
      host.id = 'm32-probe'
      // NOT an opaque overlay. Modal portals to document.body, so an opaque
      // host at z-index 99999 covers the dialog it was meant to display —
      // which is exactly what produced two byte-identical 7128-byte
      // screenshots of a flat sheet while innerText read the modal perfectly.
      host.style.cssText = 'position:fixed;inset:0;z-index:10;overflow:auto;padding:24px;background:var(--color-canvas, #111)'
      document.body.appendChild(host)

      const built = await (async function () { ${buildBody} })()
      const root = createRoot(host)
      window.__m32root = root
      root.render(built.el)
      await new Promise(function (r) { setTimeout(r, 1200) })

      // Modal portals to document.body, NOT into the host div — so reading
      // host.innerText reports 0 chars for a dialog that rendered perfectly.
      // Fall back to the whole body when the host is empty; the login screen
      // underneath is ~90 chars, well under the refuse threshold, so this
      // cannot turn a blank render into a pass.
      const hostText = host.innerText || ''
      const bodyText = document.body.innerText || ''
      const t = hostText.length > 0 ? hostText : bodyText
      const grew = bodyText.length > baseline.length + 200
      return {
        ok: true,
        info: built.info,
        chars: t.length,
        grew: hostText.length > 0 ? true : grew,
        baselineChars: baseline.length,
        text: t.split(String.fromCharCode(10)).join(' | ')
      }
    } catch (e) {
      return { __err: String((e && e.stack) || e).slice(0, 600) }
    }
  })()`)
  console.log(NL + '[' + name + '] ' + (out.info ? JSON.stringify(out.info) : ''))
  console.log('  RENDERED TEXT: ' + out.text)
  // A blank render and a broken import look identical on a screenshot. Refuse.
  if (!out.grew) {
    throw new Error(
      name + ': the page did not GAIN content (host empty, body ' + out.baselineChars +
        ' -> ' + out.chars + ' chars). Whatever is on screen was already there — not screenshotting it.'
    )
  }
  return out
}

async function shootBothThemes(prefix) {
  // ── HOW THIS WENT WRONG, AND WHY THE CHECK IS NOW A COLOUR ─────────────
  //
  // The first version toggled a 'dark' class and asserted the className
  // string changed. Three errors stacked:
  //
  //   1. There IS no 'dark' class. useTheme.ts does
  //      `classList.toggle('light', resolved === 'light')` — dark is the
  //      ABSENCE of a class. Adding 'dark' styled nothing.
  //   2. The substring test for 'light' matched **first-light**, the
  //      design-preview class, so a dark app was read as light.
  //   3. The assertion then passed on the junk class it had just added.
  //
  // Net: two byte-identical dark screenshots reported as a light/dark pass.
  // The class is a PROXY for the theme. The rendered colour is the theme.
  const readBg = () =>
    ev('getComputedStyle(document.body).backgroundColor')

  const beforeClass = await ev('document.documentElement.className')
  const beforeBg = await readBg()
  await cdp.screenshot(SHOTS + '/' + prefix + '-1.png')

  await ev(`(function () {
    const r = document.documentElement
    r.classList.toggle('light')
    return r.className
  })()`)
  await new Promise((r) => setTimeout(r, 700))
  const afterBg = await readBg()

  if (beforeBg === afterBg) {
    throw new Error(
      'theme did not actually change: body background is still ' + afterBg +
        ' — the second screenshot would be the first one again'
    )
  }
  await cdp.screenshot(SHOTS + '/' + prefix + '-2.png')

  await ev(`(function () { document.documentElement.className = ${JSON.stringify(beforeClass)}; return 1 })()`)
  await new Promise((r) => setTimeout(r, 400))
  const restoredBg = await readBg()
  console.log(
    '  theme: body bg ' + beforeBg + ' -> ' + afterBg +
      ' | restored: ' + (restoredBg === beforeBg ? 'YES' : '*** NO (' + restoredBg + ') ***')
  )
}

// ── 1. The counter + the reason prompt ──────────────────────────────────
await mount(
  'counter+prompt',
  `
  const C = await import('/src/features/deals/OutcomeInsightCard.tsx')
  const P = await import('/src/features/deals/OutcomeReasonPrompt.tsx')
  const state = await window.api.dealBackfill.state()
  const noop = function () {}
  const el = h('div', { style: { maxWidth: '980px', margin: '0 auto' } },
    h(C.OutcomeInsightCard, {
      key: 'c',
      insight: state.insight,
      unansweredRows: state.total - state.answered,
      onOpenBackfill: noop
    }),
    h(P.OutcomeReasonPrompt, {
      key: 'w', dealTitle: 'Acme Robotics', kind: 'won', stageLabel: 'Won',
      onSave: noop, onSkip: noop
    }),
    h(P.OutcomeReasonPrompt, {
      key: 'l', dealTitle: 'Northwind Traders', kind: 'lost', stageLabel: 'Lost',
      onSave: noop, onSkip: noop
    }),
    h(P.OutcomeReasonRetiredNotice, { key: 'r', onDismiss: noop })
  )
  return { el: el, info: { insight: state.insight, rows: state.total, answered: state.answered } }
`
)
await shootBothThemes('counter')

// ── 2. The backfill, with REAL rows ─────────────────────────────────────
await mount(
  'backfill',
  `
  const B = await import('/src/features/deals/OutcomeBackfillDialog.tsx')
  const noop = function () {}
  const el = h(B.OutcomeBackfillDialog, { onClose: noop, onChanged: noop })
  return { el: el, info: { note: 'real rows via dealBackfill.state()' } }
`
)
await shootBothThemes('backfill')

// The tenth-row rules, read off the DOM rather than off the source.
const shape = await ev(`(function () {
  const APOS = String.fromCharCode(39)
  const LABELS = ['Won', 'Lost', 'Went quiet', 'Don' + APOS + 't remember', 'Not a deal']
  const rows = []
  const lis = document.querySelectorAll('li')
  for (let i = 0; i < lis.length; i++) {
    const btns = lis[i].querySelectorAll('button')
    let n = 0
    for (let j = 0; j < btns.length; j++) {
      if (LABELS.indexOf((btns[j].textContent || '').trim()) !== -1) n++
    }
    if (n > 0) {
      rows.push({
        answerButtons: n,
        hasClear: lis[i].querySelector('[aria-label="Clear this answer"]') !== null
      })
    }
  }
  const allFive = rows.length > 0 && rows.every(function (r) { return r.answerButtons === 5 })
  const allClear = rows.length > 0 && rows.every(function (r) { return r.hasClear })
  return { rowCount: rows.length, everyRowHasAllFive: allFive, everyRowHasClear: allClear }
})()`)
console.log(NL + '[backfill] STRUCTURE, read off the DOM:')
console.log('  ' + JSON.stringify(shape))
if (!shape.everyRowHasAllFive) {
  throw new Error('not every row carries all five answer buttons — a correction would not be one click')
}

// ── Clean up: leave the page exactly as found ───────────────────────────
await ev(`(function () {
  if (window.__m32root) {
    try { window.__m32root.unmount() } catch (e) {}
    window.__m32root = null
  }
  const p = document.getElementById('m32-probe')
  if (p) p.remove()
  return 1
})()`)
const leftover = await ev(`(function () {
  const APOS = String.fromCharCode(39)
  const LABELS = ['Won', 'Lost', 'Went quiet', 'Don' + APOS + 't remember', 'Not a deal']
  let n = 0
  const btns = document.querySelectorAll('button')
  for (let i = 0; i < btns.length; i++) {
    if (LABELS.indexOf((btns[i].textContent || '').trim()) !== -1) n++
  }
  return { hostGone: document.getElementById('m32-probe') === null, strayAnswerButtons: n }
})()`)
console.log(NL + '[cleanup] ' + JSON.stringify(leftover))
if (!leftover.hostGone || leftover.strayAnswerButtons > 0) {
  throw new Error('cleanup left something behind — the next run would measure a pile, not a render')
}
await cdp.close()
console.log('DONE')
