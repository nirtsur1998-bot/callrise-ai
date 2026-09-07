/**
 * Drive and READ the running Electron app over the Chrome DevTools Protocol.
 *
 * Built for the BUG-200 proof, where "I clicked it" is not evidence and a
 * screenshot is not a state read. Requires the app to have been started with
 * a debugging port:
 *
 *   npx electron-vite dev --remoteDebuggingPort 9222
 *
 * Subcommands:
 *   targets                       list every debuggable target
 *   eval   "<js>"                 evaluate in the renderer, print JSON result
 *   text   "<css selector>"       print innerText of every match
 *   click  "<css selector>"       real mouse events at the element's centre
 *   shot   <file.png>             screenshot the renderer, print its sha256
 *   wait   "<js>" [timeoutMs]     poll until the expression is truthy
 *
 * WHY REAL MOUSE EVENTS for `click` rather than `el.click()`: a React handler
 * bound through a synthetic event system, a disabled overlay, or an element
 * covered by something else all behave differently. `el.click()` would fire
 * the handler on an element a user could not reach. This dispatches at the
 * element's centre coordinates and therefore hits whatever is actually on
 * top, which is the thing being proven.
 */
const WebSocket = require('ws')
const { writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')

const PORT = process.env.CDP_PORT || 9222
const [cmd, arg1, arg2] = process.argv.slice(2)

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  if (!res.ok) throw new Error(`no debugger on ${PORT} (${res.status}) — was the app started with --remoteDebuggingPort?`)
  return res.json()
}

/** The renderer page, chosen explicitly rather than "the first one". Electron
 *  exposes devtools pages, service workers and sometimes a second window; a
 *  silent wrong pick would report on a target nobody is looking at. */
async function rendererTarget() {
  const list = await targets()
  const pages = list.filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
  if (pages.length === 0) throw new Error('no renderer page target found')
  const app = pages.filter((t) => /localhost:5173|file:\/\//.test(t.url))
  const chosen = (app.length ? app : pages)[0]
  if ((app.length ? app : pages).length > 1) {
    process.stderr.write(
      `WARNING: ${pages.length} page targets; using ${chosen.url}. Others: ` +
        pages.filter((p) => p !== chosen).map((p) => p.url).join(', ') + '\n'
    )
  }
  return chosen
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 })
    let id = 0
    const pending = new Map()
    ws.on('open', () =>
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const n = ++id
            pending.set(n, { res, rej })
            ws.send(JSON.stringify({ id: n, method, params: params || {} }))
          })
        },
        close: () => ws.close()
      })
    )
    ws.on('error', reject)
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(msg.error.message))
        else res(msg.result)
      }
    })
  })
}

async function evaluate(client, expression) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (r.exceptionDetails) {
    throw new Error(
      'evaluation threw: ' +
        (r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    )
  }
  return r.result.value
}

async function main() {
  if (cmd === 'targets') {
    const list = await targets()
    for (const t of list) console.log(`${t.type}\t${t.title}\t${t.url}`)
    return
  }

  const target = await rendererTarget()
  const client = await connect(target.webSocketDebuggerUrl)

  try {
    if (cmd === 'eval') {
      console.log(JSON.stringify(await evaluate(client, arg1), null, 2))
    } else if (cmd === 'text') {
      const out = await evaluate(
        client,
        `[...document.querySelectorAll(${JSON.stringify(arg1)})].map(e => e.innerText)`
      )
      console.log(JSON.stringify(out, null, 2))
    } else if (cmd === 'click') {
      const box = await evaluate(
        client,
        `(() => { const e = document.querySelector(${JSON.stringify(arg1)});
          if (!e) return null;
          e.scrollIntoView({block:'center'});
          const r = e.getBoundingClientRect();
          return {x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height}; })()`
      )
      if (!box) throw new Error(`no element matches ${arg1}`)
      if (box.w === 0 || box.h === 0) throw new Error(`${arg1} has zero size — not clickable`)
      // What is actually on top at that point? Clicking a covered element is
      // the classic false positive: the event fires on the overlay and the
      // test reports a click that the user could never make.
      const onTop = await evaluate(
        client,
        `(() => { const t = document.elementFromPoint(${box.x}, ${box.y});
          const want = document.querySelector(${JSON.stringify(arg1)});
          return { tag: t && t.tagName, isTargetOrChild: !!(t && want && (t === want || want.contains(t) || t.contains(want))) }; })()`
      )
      if (!onTop.isTargetOrChild) {
        throw new Error(
          `${arg1} is covered at its centre by <${onTop.tag}> — refusing to click something the user cannot`
        )
      }
      for (const type of ['mousePressed', 'mouseReleased']) {
        await client.send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        })
      }
      console.log(JSON.stringify({ clicked: arg1, at: box, onTop }, null, 2))
    } else if (cmd === 'shot') {
      const r = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const buf = Buffer.from(r.data, 'base64')
      writeFileSync(arg1, buf)
      console.log(
        JSON.stringify(
          { file: arg1, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') },
          null,
          2
        )
      )
    } else if (cmd === 'wait') {
      const timeout = Number(arg2 || 30000)
      const started = Date.now()
      for (;;) {
        let v = null
        try {
          v = await evaluate(client, arg1)
        } catch {
          /* the page may be mid-render; keep polling */
        }
        if (v) {
          console.log(JSON.stringify({ satisfied: true, afterMs: Date.now() - started, value: v }, null, 2))
          return
        }
        if (Date.now() - started > timeout) {
          console.log(JSON.stringify({ satisfied: false, afterMs: Date.now() - started }, null, 2))
          process.exitCode = 1
          return
        }
        await new Promise((r) => setTimeout(r, 400))
      }
    } else {
      console.error('unknown command: ' + cmd)
      process.exitCode = 2
    }
  } finally {
    client.close()
  }
}

main().catch((e) => {
  console.error('FAILED: ' + e.message)
  process.exit(1)
})
