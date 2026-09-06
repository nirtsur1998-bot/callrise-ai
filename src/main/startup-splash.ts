/**
 * BUG-191 (M35 Stage 2 walk, 2026-09-05) — the startup splash.
 *
 * On a clean 4 GB machine, "Run CallRise AI" from the installer's Finish
 * produced NOTHING on screen for about 35 seconds: no window, no taskbar
 * entry, six CallRiseAI processes and no way to tell them from a failed
 * launch. The main window is constructed only after every registerX() call
 * and several awaited loads in index.ts, and then shown only on
 * 'ready-to-show' (to avoid a white flash) — correct for the window, blind
 * for the person waiting.
 *
 * This keeps a small frameless window on screen from the moment the app is
 * ready until the main window reports ready-to-show, and not a moment
 * longer. The controller is pure so the ordering is tested; the Electron
 * window is built by `openSplashWindow` below and is the only part the
 * suite cannot exercise.
 */

export type SplashState = 'idle' | 'shown' | 'closed'

export interface SplashHooks {
  open: () => void
  close: () => void
}

export interface StartupSplash {
  /** Call as early as possible inside app.whenReady(). */
  appReady: () => void
  /** Call from the main window's 'ready-to-show'. Idempotent. */
  mainWindowReady: () => void
  state: () => SplashState
}

export function createStartupSplash(hooks: SplashHooks): StartupSplash {
  let state: SplashState = 'idle'
  let mainReadyFirst = false
  return {
    appReady: () => {
      if (state !== 'idle') return
      // The real window beat us to it (an 'activate' path, a fast machine):
      // never flash a splash over an already-visible app.
      if (mainReadyFirst) {
        state = 'closed'
        return
      }
      try {
        hooks.open()
        state = 'shown'
      } catch {
        // A splash that cannot open must not take the app down with it.
        state = 'closed'
      }
    },
    mainWindowReady: () => {
      if (state === 'idle') {
        mainReadyFirst = true
        return
      }
      if (state !== 'shown') return
      state = 'closed'
      try {
        hooks.close()
      } catch {
        /* already gone */
      }
    },
    state: () => state
  }
}

/** The splash's own markup — no renderer bundle, no IPC, nothing to wait for.
 *  Colours match the app's dark canvas so the hand-off to the real window is
 *  a size change, not a flash. */
export function splashHtml(version: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>CallRise AI</title>
<style>
  html,body{margin:0;height:100%;background:#111214;color:#e8e6e3;font:14px system-ui,Segoe UI,sans-serif;-webkit-app-region:drag;user-select:none}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  .logo{width:44px;height:44px;border-radius:12px;background:#e08a2e;display:grid;place-items:center}
  .logo span{display:block;width:22px;height:14px;background:
    linear-gradient(#fff,#fff) 0 50%/3px 8px no-repeat,
    linear-gradient(#fff,#fff) 5px 50%/3px 14px no-repeat,
    linear-gradient(#fff,#fff) 10px 50%/3px 10px no-repeat,
    linear-gradient(#fff,#fff) 15px 50%/3px 14px no-repeat,
    linear-gradient(#fff,#fff) 20px 50%/2px 6px no-repeat}
  .name{font-weight:600;font-size:15px}
  .sub{color:#9a9793;font-size:12px}
  .bar{width:160px;height:3px;border-radius:2px;background:#26282c;overflow:hidden}
  .bar i{display:block;width:40%;height:100%;background:#e08a2e;animation:s 1.2s ease-in-out infinite}
  @keyframes s{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}
  .v{position:absolute;bottom:10px;right:12px;color:#5f5c58;font-size:11px}
</style></head><body><div class="wrap">
  <div class="logo"><span></span></div>
  <div class="name">CallRise AI</div>
  <div class="sub">Starting up&hellip; this can take a moment the first time.</div>
  <div class="bar"><i></i></div>
</div><div class="v">${version}</div></body></html>`
}

/**
 * Build the Electron window. Kept behind a factory so index.ts wires it in
 * one line and nothing here is imported by tests (electron is not available
 * to the suite). Returns the hooks the controller needs.
 */
interface SplashWin {
  loadURL: (url: string) => Promise<void>
  close: () => void
  isDestroyed: () => boolean
}

export function openSplashWindow(deps: {
  BrowserWindow: new (opts: Record<string, unknown>) => SplashWin
  version: string
}): SplashHooks {
  let win: SplashWin | null = null
  return {
    open: () => {
      const w = new deps.BrowserWindow({
        width: 360,
        height: 220,
        frame: false,
        resizable: false,
        movable: true,
        alwaysOnTop: false,
        center: true,
        // show:true, on purpose. Gating on 'ready-to-show' (the main window's
        // habit, to avoid a white flash) made this splash invisible for
        // exactly the period it exists for: on a cold start its own page
        // waits on the same GPU and disk-cache initialisation as the main
        // renderer, so both painted together. Electron fills a shown window
        // with backgroundColor natively, before any page — that fill IS the
        // splash for the first seconds; the markup arrives when it can.
        show: true,
        backgroundColor: '#111214',
        title: 'CallRise AI',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
      })
      win = w
      void w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml(deps.version)))
    },
    close: () => {
      const w = win
      win = null
      if (w && !w.isDestroyed()) w.close()
    }
  }
}
