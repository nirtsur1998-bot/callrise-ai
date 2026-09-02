// Can the founder actually REACH every row? The modal is a centered flex item
// with overflow-hidden and no max-height; with 15 rows it may extend past the
// viewport in both directions with nothing to scroll.
//
// Measured, not reasoned about: a row that renders is not a row that can be
// clicked, and `innerText` reports both identically.
import { connect } from 'file:///C:/Users/User/Desktop/callrise-m32/scripts/verification/cdp.mjs'

const cdp = await connect(9333)
await cdp.send('Page.enable', {})
await cdp.send('Page.reload', {})
await new Promise((r) => setTimeout(r, 4500))

const out = await cdp.evaluate(`(async () => {
  try {
    const entry = await (await fetch('/src/main.tsx')).text()
    const findUrl = function (needle) {
      const i = entry.indexOf(needle)
      const q = String.fromCharCode(34)
      return entry.slice(entry.lastIndexOf(q, i) + 1, entry.indexOf(q, i))
    }
    const rmod = await import(findUrl('/deps/react.js'))
    const React = rmod.default || rmod
    const dmod = await import(findUrl('/deps/react-dom_client.js'))
    const createRoot = (dmod.default || dmod).createRoot
    const B = await import('/src/features/deals/OutcomeBackfillDialog.tsx')

    const host = document.createElement('div')
    host.id = 'reach'
    document.body.appendChild(host)
    const root = createRoot(host)
    window.__reachRoot = root
    root.render(React.createElement(B.OutcomeBackfillDialog, {
      onClose: function () {}, onChanged: function () {}
    }))
    await new Promise(function (r) { setTimeout(r, 1800) })

    const APOS = String.fromCharCode(39)
    const LABELS = ['Won', 'Lost', 'Went quiet', 'Don' + APOS + 't remember', 'Not a deal']
    const rows = []
    const lis = document.querySelectorAll('li')
    for (let i = 0; i < lis.length; i++) {
      const btns = lis[i].querySelectorAll('button')
      let won = null
      for (let j = 0; j < btns.length; j++) {
        if ((btns[j].textContent || '').trim() === 'Won') { won = btns[j]; break }
      }
      if (!won) continue
      // SCROLL IT INTO VIEW FIRST, then ask. "Is it on screen right now" is
      // the wrong question for a scrolling list — it would fail 12 of 15 rows
      // that a user reaches perfectly well by scrolling. The real question is
      // whether the row can be brought under the cursor AT ALL, and whether a
      // click at that point would land on the button rather than on something
      // covering it.
      won.scrollIntoView({ block: 'center' })
      await new Promise(function (rr) { setTimeout(rr, 40) })
      const r = won.getBoundingClientRect()
      const cx = r.x + r.width / 2
      const cy = r.y + r.height / 2
      const onScreen = cy > 0 && cy < innerHeight && cx > 0 && cx < innerWidth
      const hit = onScreen ? document.elementFromPoint(cx, cy) : null
      rows.push({
        i: rows.length,
        name: (lis[i].innerText || '').split(String.fromCharCode(10))[0].slice(0, 18),
        y: Math.round(r.y),
        onScreen: onScreen,
        clickLandsOnIt: hit ? (hit === won || won.contains(hit)) : false
      })
    }

    // Is anything scrollable that would let the user reach the rest?
    const panel = document.querySelector('[aria-modal="true"]')
    const pr = panel ? panel.getBoundingClientRect() : null
    const scrollables = []
    let n = panel
    while (n && n !== document.body) {
      const st = getComputedStyle(n)
      if (n.scrollHeight > n.clientHeight + 4 && (st.overflowY === 'auto' || st.overflowY === 'scroll')) {
        scrollables.push(n.className.slice(0, 40))
      }
      n = n.parentElement
    }

    return {
      viewportH: innerHeight,
      panelTop: pr ? Math.round(pr.top) : null,
      panelHeight: pr ? Math.round(pr.height) : null,
      panelOverflowsViewport: pr ? pr.height > innerHeight : null,
      bodyScrollable: document.body.scrollHeight > innerHeight + 4,
      scrollableAncestors: scrollables,
      totalRows: rows.length,
      reachable: rows.filter(function (r) { return r.clickLandsOnIt }).length,
      unreachable: rows.filter(function (r) { return !r.clickLandsOnIt })
        .map(function (r) { return r.name + '@y=' + r.y })
    }
  } catch (e) { return { fatal: String((e && e.stack) || e).slice(0, 500) } }
})()`)

console.log(JSON.stringify(out, null, 2))

await cdp.evaluate(`(function () {
  if (window.__reachRoot) { try { window.__reachRoot.unmount() } catch (e) {} window.__reachRoot = null }
  const h = document.getElementById('reach'); if (h) h.remove()
  return 1
})()`)
await cdp.close()
