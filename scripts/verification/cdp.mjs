// ---------------------------------------------------------------------------
// Minimal Chrome DevTools Protocol client for driving the CallRise renderer.
//
// WHY THIS EXISTS, rather than more pixel-clicking:
// the Win32 driver captures whatever pixels sit at a rectangle. That is the
// right instrument for "does the real window look right" and the WRONG one for
// "did prefers-reduced-motion actually reach the CSS" — a screenshot of a still
// UI is identical whether motion is reduced or not. CDP reads the state the
// browser itself computed, so the answer comes from the same input the CSS sees
// rather than from my reading of the code.
//
// No new dependency: node 24 ships a global WebSocket.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs'

export async function targets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`)
  return r.json()
}

export async function connect(port, { titleMatch } = {}) {
  let list = []
  // The renderer takes a moment to register; poll rather than assume.
  for (let i = 0; i < 40; i++) {
    try {
      list = await targets(port)
      if (list.some((t) => t.type === 'page' && t.webSocketDebuggerUrl)) break
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!pages.length) throw new Error('no CDP page target — targets seen: ' + JSON.stringify(list.map(t => t.type + ':' + t.title)))

  // PIN THE MAIN WINDOW. This used to take pages[0] blindly, and the app
  // publishes TWO page targets with the SAME title ("CallRise AI"): the main
  // window and index.html#/detection-overlay. /json/list orders by recent
  // activity, not by identity, so pages[0] is not a stable reference to
  // anything — the same failure as the screenshot driver's "any Electron
  // window" fallback, one layer down, and just as silent: the overlay would
  // have answered every query with plausible-looking values from the wrong
  // window. Select by URL and REFUSE rather than guess.
  const mains = pages.filter((p) => !p.url.includes('#/'))
  if (mains.length !== 1) {
    throw new Error(
      `expected exactly 1 main window, found ${mains.length}. All page targets:\n` +
        pages.map((p) => `  ${p.title} :: ${p.url}`).join('\n')
    )
  }
  const page = titleMatch ? pages.find((p) => p.title.includes(titleMatch)) ?? mains[0] : mains[0]
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')) })

  let id = 0
  const pending = new Map()
  // EVENTS, added 2026-09-09. This handler used to drop every message without
  // an `id`, which is every CDP EVENT — and that made one whole class of drive
  // impossible rather than merely awkward: `window.confirm` in Electron is a
  // NATIVE modal that blocks the renderer, so a driver that clicks a
  // destructive button and cannot hear `Page.javascriptDialogOpening` has no
  // way to answer the dialog. The renderer stops, and so does the next
  // `Runtime.evaluate`, which surfaces as a CDP timeout on an unrelated call.
  //
  // Found while driving BUG-237's "Forget everything" — a confirm dialog is
  // exactly what guards the buttons most worth driving.
  const listeners = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      return
    }
    if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) {
        // A listener must never be able to kill the connection.
        try {
          fn(msg.params)
        } catch (err) {
          console.error(`[cdp] listener for ${msg.method} threw: ${err.message}`)
        }
      }
    }
  }
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id
      pending.set(mid, { res, rej })
      ws.send(JSON.stringify({ id: mid, method, params }))
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error('CDP timeout: ' + method)) } }, 30000)
    })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true
    })
    if (r.exceptionDetails) throw new Error('eval threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }

  const screenshot = async (path) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(path, Buffer.from(r.data, 'base64'))
    return path
  }

  /** Subscribe to a CDP event, e.g. on('Page.javascriptDialogOpening', fn). */
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, [])
    listeners.get(method).push(fn)
  }

  /**
   * Answer native window.confirm/alert/prompt dialogs so a drive can click the
   * buttons that matter. Returns a getter for what was actually asked — assert
   * on the WORDING, not merely that something was accepted: "it confirmed" and
   * "it confirmed the right irreversible action" are different findings.
   */
  const autoAnswerDialogs = async (accept = true) => {
    const seen = []
    on('Page.javascriptDialogOpening', (p) => {
      seen.push({ type: p.type, message: p.message })
      void send('Page.handleJavaScriptDialog', { accept })
    })
    await send('Page.enable')
    return () => seen
  }

  return { send, on, autoAnswerDialogs, evaluate, screenshot, page, close: () => ws.close() }
}
