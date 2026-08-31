// UI-DRIVER — one driver, with every rule the last three sessions paid for
// built into it rather than remembered.
//
// WHY THIS EXISTS. Four separate ad-hoc drivers were written across M32, each
// re-deriving the same lessons, and each rediscovering one of them the hard
// way. The founder's instruction, 2026-08-31: *"Use whatever tooling makes that
// reliable rather than working around gaps. Don't hand-roll a third screenshot
// driver."* So the rules live here, as behaviour, and a caller cannot skip one
// by forgetting it.
//
// EVERY RULE BELOW CAUGHT A REAL WRONG RESULT. None is hypothetical:
//
//  1. CONFIRM THE BUILD FIRST. A visual pass against the wrong binary is worse
//     than no pass — it produces confident screenshots of the old behaviour.
//     The page URL is the proof (a path cannot be coincidentally present the
//     way a marker string can); `resources/app.asar` means packaged, a worktree
//     path means dev.
//  2. A CLICK THAT REPORTS SUCCESS PROVES NOTHING. `element.click()` returned
//     CLICKED while the page did not move — it had matched a wrapper with no
//     handler. Real dispatched mouse events only, and read the state after.
//  3. ASSERT THE STATE **CHANGED**, NOT THAT IT MATCHES. A light-theme check
//     passed because the app was already light; every screenshot up to that
//     point was light while a two-theme pass was believed to be underway. The
//     check itself supplied the false confirmation.
//  4. SCROLL INTO VIEW, THEN REFUSE IF STILL OFF-SCREEN. `getBoundingClientRect`
//     is viewport-relative; an element below the fold has a y outside the
//     window and the click lands on nothing, silently. The 9th card on a page
//     of 12 ate both a click and an insertText.
//  5. REFUSE RATHER THAN GUESS. 12 buttons read "Test key". Picking the first
//     is how a driver operates on the wrong thing and reports success.
//  6. CLEAR BEFORE TYPING. `insertText` APPENDS; a field with leftover content
//     produced "עעעFAKEKEYTWO", caught only by reading the value back.
//
// Anything that WRITES must additionally run inside `withRestoredState` from
// state-guard.mjs. This module deliberately does not wrap it for you: the
// snapshot has to be taken before the app is even launched in some flows, so
// forcing it here would encourage the wrong shape.
import { connect } from './cdp.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Connect and REFUSE unless the running app is the build you meant.
 *
 * `expect` is 'packaged' | 'dev' | a substring the page URL must contain.
 * There is no "either is fine" option on purpose — not knowing which build
 * answered is the condition this exists to prevent.
 */
export async function openApp(port, { expect: expectBuild } = {}) {
  const cdp = await connect(port)
  const url = cdp.page.url
  const isPackaged = url.includes('app.asar')
  if (expectBuild === 'packaged' && !isPackaged) {
    throw new Error(`expected the PACKAGED build, got a dev page: ${url}`)
  }
  if (expectBuild === 'dev' && isPackaged) {
    throw new Error(`expected a DEV build, got the packaged app: ${url}`)
  }
  if (typeof expectBuild === 'string' && !['packaged', 'dev'].includes(expectBuild)) {
    if (!url.includes(expectBuild)) {
      throw new Error(`page URL does not contain ${JSON.stringify(expectBuild)}: ${url}`)
    }
  }
  console.log(`[ui] driving ${isPackaged ? 'PACKAGED' : 'DEV'} build: ${url}`)
  return wrap(cdp)
}

function wrap(cdp) {
  /** Locate exactly one element, scrolled into view, or refuse. */
  async function locate(desc) {
    const { text, exact = true, selector = 'button, a, [role="button"], [role="tab"]', placeholder, within } = desc
    const box = await cdp.evaluate(`(() => {
      const byPlaceholder = ${placeholder ? 'true' : 'false'}
      let scope = document
      ${within ? `
      const anchor = [...document.querySelectorAll('input')].find(i => i.placeholder === ${JSON.stringify(within)})
      if (!anchor) return { err: 'scope anchor not found: ' + ${JSON.stringify(within)} }
      scope = anchor.closest('div[class*="rounded"]') || anchor.parentElement
      ` : ''}
      const all = byPlaceholder
        ? [...scope.querySelectorAll('input, textarea')].filter(i => i.placeholder === ${JSON.stringify(placeholder ?? '')})
        : [...scope.querySelectorAll(${JSON.stringify(selector)})].filter(e => {
            const t = (e.textContent || '').trim()
            return ${exact} ? t === ${JSON.stringify(text ?? '')} : t.includes(${JSON.stringify(text ?? '')})
          })
      // RULE 5 — refuse rather than guess.
      if (all.length !== 1) return { err: 'expected exactly 1 match, found ' + all.length }
      const el = all[0]
      // RULE 4 — scroll, then verify it is really on screen.
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      if (!(r.y > 0 && r.y < innerHeight && r.width > 0)) {
        return { err: 'off-screen after scrollIntoView (y=' + Math.round(r.y) + ', h=' + innerHeight + ')' }
      }
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    if (box.err) throw new Error(`locate ${JSON.stringify(desc)} -> ${box.err}`)
    return box
  }

  /** RULE 2 — a real dispatched click. Never element.click(). */
  async function click(desc, { settle = 1000 } = {}) {
    const box = await locate(typeof desc === 'string' ? { text: desc } : desc)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {
        type, x: box.x, y: box.y, button: 'left', clickCount: 1
      })
    }
    await sleep(settle)
  }

  /**
   * RULE 3 — do the thing, then assert the world MOVED.
   * `read` returns whatever you want compared; the action is rejected if it
   * leaves that value untouched.
   */
  async function actAndExpectChange(label, read, action) {
    const before = await read()
    await action()
    const after = await read()
    if (JSON.stringify(before) === JSON.stringify(after)) {
      throw new Error(
        `${label}: state did NOT change — the action was a no-op.\n  value stayed: ${JSON.stringify(before)}`
      )
    }
    return { before, after }
  }

  /** RULE 6 — select-all, then insert, then READ IT BACK. */
  async function type(placeholder, value, { within } = {}) {
    const box = await locate({ placeholder, within })
    for (const t of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type: t, x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    for (const t of ['keyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: t, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2
      })
    }
    await sleep(150)
    await cdp.send('Input.insertText', { text: value })
    await sleep(300)
    const got = await cdp.evaluate(
      `[...document.querySelectorAll('input, textarea')].find(x => x.placeholder === ${JSON.stringify(placeholder)}).value`
    )
    if (got !== value) throw new Error(`typing did not land: wanted ${JSON.stringify(value)}, field reads ${JSON.stringify(got)}`)
  }

  /** Visible text of the smallest card containing a given placeholder. */
  async function cardText(placeholder) {
    return cdp.evaluate(`(() => {
      const i = [...document.querySelectorAll('input, textarea')].find(x => x.placeholder === ${JSON.stringify(placeholder)})
      if (!i) return null
      const card = i.closest('div[class*="rounded"]')
      return (card ? card.innerText : '').split(String.fromCharCode(10)).join(' | ')
    })()`)
  }

  /** Count exact-match visible labels — the shape most of these checks take. */
  async function countLabels(labels) {
    return cdp.evaluate(`(() => {
      const want = ${JSON.stringify(labels)}
      const c = {}; for (const w of want) c[w] = 0
      for (const el of document.querySelectorAll('span, div, p, button')) {
        const t = (el.textContent || '').trim()
        if (want.includes(t)) c[t]++
      }
      return c
    })()`)
  }

  return {
    raw: cdp,
    page: cdp.page,
    locate,
    click,
    type,
    cardText,
    countLabels,
    actAndExpectChange,
    text: () => cdp.evaluate('document.body.innerText'),
    evaluate: (e) => cdp.evaluate(e),
    send: (m, p) => cdp.send(m, p),
    screenshot: (p) => cdp.screenshot(p),
    close: () => cdp.close()
  }
}
