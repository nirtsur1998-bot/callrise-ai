// Diagnostic crash log, written with fs.writeFileSync (synchronous — cannot be
// lost to the async-stdout-flush-on-exit race that swallows console output on
// Windows when a process exits immediately after writing to it) to a fixed,
// Electron-readiness-independent path. Registered before every other import so
// it catches a throw from ANY of them, not just from this file's own code.
// TEMPORARY: added to chase a real Windows launch failure that produces zero
// output through every normal channel (console, --enable-logging, Event
// Viewer, WER) - remove once that's root-caused.
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join as joinPathForCrashLog } from 'path'
const crashLogPath = joinPathForCrashLog(tmpdir(), 'callrise-startup-crash.log')
function writeCrashLog(label: string, err: unknown): void {
  try {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
    writeFileSync(crashLogPath, `[${new Date().toISOString()}] ${label}\n${detail}\n`, {
      flag: 'a'
    })
  } catch {
    /* if we can't even write the crash log, there's nothing further to do */
  }
}
process.on('uncaughtException', (err) => writeCrashLog('uncaughtException', err))
process.on('unhandledRejection', (err) => writeCrashLog('unhandledRejection', err))
writeCrashLog('process started', 'reached top of main/index.ts')

import { config as loadEnv } from 'dotenv'
import { app, shell, BrowserWindow, session } from 'electron'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { DEFAULT_CONFIG } from './default-config'
import { clearActiveConsent } from './consent-gate'
writeCrashLog('imports resolved', 'all top-level imports completed without throwing')

// Renamed "Sales OS" -> "CallRise AI" (rebrand), but the on-disk data folder
// keeps its original name so existing calls/tasks/settings/consent/Google
// tokens aren't orphaned by the rename. Must run before app is ready.
app.setName('CallRise AI')
const userDataDir = join(app.getPath('appData'), 'sales-os')
app.setPath('userData', userDataDir)

// Lets the audio worklet hand PCM to its worker through shared memory (§1.4),
// so audio never waits on the renderer's main thread. Chromium otherwise gates
// SharedArrayBuffer behind cross-origin isolation, which exists to keep a
// *hostile page* from timing the Spectre side channel — a threat that needs
// third-party content to exploit, and this window only ever loads the app's own
// bundle from disk. Nothing depends on the switch working: startAudioPump()
// constructs a SharedArrayBuffer to test for it and falls back to the original
// postMessage path if it throws.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')

// Dev reads the project's .env from the working directory. A packaged app has
// no project folder (and its working directory is arbitrary), so also look
// next to the executable and in the app's data folder — installs get their
// keys by dropping a .env in either place.
const envPaths = [
  '.env',
  join(dirname(process.execPath), '.env'),
  join(userDataDir, '.env')
].filter((p) => existsSync(p))
if (envPaths.length > 0) loadEnv({ path: envPaths })

// Fill in only what's still missing after any .env — a developer's own .env
// (e.g. pointing at a different Supabase project) always wins. This is what
// lets a fresh install log in and sync Google Calendar with zero setup.
for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
  if (!process.env[key]) process.env[key] = value
}
import icon from '../../resources/icon.png?asset'
import { registerTranscription, disposeTranscription } from './transcription'
import { registerCalls } from './calls'
import { registerTasks } from './tasks'
import { registerContacts } from './contacts'
import { registerDeals } from './deals'
import { registerDealStages } from './deal-stages'
import { registerAuth } from './auth'
import { registerEvents } from './events'
import { registerLiveCue } from './live-cue'
import { registerLoopbackCapture } from './loopback'
import { registerGoogle } from './google'
import { registerOutlook } from './outlook'
import { registerBackup } from './backup'
import { registerVirtualMic, disposeVirtualMic } from './virtualmic'
import { registerKnowledge } from './knowledge'
import { registerObjectionQueue } from './objection-queue'
import { registerAppSettings } from './app-settings'
import { registerLaunchAtLogin } from './launch-at-login'
import { registerActiveApp } from './active-app'
import { registerAlerts } from './alerts'
import {
  registerDetectionService,
  disposeDetectionService,
  setMainWindow,
  handleMainWindowClosed
} from './detection-service'
import { disposeOverlay } from './detection-overlay'
import { disposeTray } from './detection-tray'
import { registerCoachPdf } from './coach-pdf'
import { registerAiKeys, loadStoredAiKeysIntoEnv } from './ai-keys'
import { registerUpdater } from './updater'
import { buildDiagnoseReport, wantsDiagnose } from './diagnose'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d11',
    // On macOS, hide the title bar for a clean Linear/Raycast-style look.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Only show the window once the UI is painted (avoids a white flash).
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Open external links in the real browser — but only safe web schemes.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(url)
      }
    } catch {
      /* ignore malformed URLs */
    }
    return { action: 'deny' }
  })

  // Defense in depth: never let the window navigate away from the app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if ((devUrl && url.startsWith(devUrl)) || url.startsWith('file://')) return
    event.preventDefault()
  })

  mainWindow.on('closed', () => {
    disposeTranscription()
    handleMainWindowClosed()
    mainWindow = null
    setMainWindow(null)
  })

  setMainWindow(mainWindow)

  // In development, load the Vite dev server (with hot reload).
  // In production, load the built HTML file.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  writeCrashLog('whenReady fired', 'app is ready, starting registration sequence')
  electronApp.setAppUserModelId('ai.callrise.app')

  // `--diagnose`: print one block of text a tester can paste back, then exit
  // without ever opening a window. Runs before anything else registers, so a
  // machine where the app fails to start for some OTHER reason can still be
  // asked what it thinks its own state is.
  if (wantsDiagnose()) {
    await loadStoredAiKeysIntoEnv().catch(() => {})
    process.stdout.write(`${buildDiagnoseReport()}\n`)
    app.exit(0)
    return
  }

  // Before anything that might use Deepgram/Anthropic — a user's own
  // Settings-entered key (if any) needs to be in process.env first.
  await loadStoredAiKeysIntoEnv()
  registerAiKeys()

  // Any consent record still on disk belongs to a call that is already over —
  // this process has not started one. A crash mid-call must never leave behind
  // a grant that authorises the NEXT launch's first call.
  clearActiveConsent()

  // In dev, Electron shows its own default dock icon on macOS unless we set
  // one explicitly (packaged builds pick it up automatically from build/icon.png).
  if (process.platform === 'darwin') app.dock?.setIcon(icon)

  // Grant microphone capture only to our own window, nothing else.
  const isOurWindow = (wc: Electron.WebContents | null): boolean =>
    wc !== null && wc === mainWindow?.webContents

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' && isOurWindow(wc))
  })
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission) => permission === 'media' && isOurWindow(wc)
  )

  // Content-Security-Policy as a real response HEADER, not only the <meta> tag
  // in index.html (§5.3).
  //
  // The meta tag is a fallback, not equivalent: several directives are ignored
  // when delivered that way (frame-ancestors among them), and a meta tag only
  // applies once the document has parsed far enough to reach it. A header
  // applies to the response itself.
  //
  // This matters here specifically because transcripts are ATTACKER-INFLUENCED
  // TEXT — the person on the other end of the call chooses the words that get
  // rendered in this window — and so is every model response derived from
  // them. Nothing renders that text as HTML today (audited: no innerHTML, no
  // dangerouslySetInnerHTML anywhere in the renderer), so this is defence in
  // depth against a future component that does.
  //
  // Packaged builds only. In development the renderer is served by Vite, whose
  // HMR client needs inline scripts and a websocket back to the dev server;
  // applying the production policy there would break `npm run dev`, which is
  // how this app is actually developed. The <meta> tag still covers dev.
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            [
              "default-src 'self'",
              "script-src 'self'",
              // Tailwind injects styles at runtime, so inline styles stay.
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self' data:",
              // The renderer talks to main over IPC, never over the network —
              // every outbound call (Deepgram, the AI providers, Supabase,
              // Google, Outlook) is made from the main process. So the
              // renderer needs no network origins at all, and saying so means
              // injected script has nowhere to send what it steals.
              "connect-src 'self'",
              "object-src 'none'",
              "base-uri 'none'",
              "frame-ancestors 'none'",
              "form-action 'none'"
            ].join('; ')
          ]
        }
      })
    })
  }

  // Inert unless UPDATE_FEED_URL names a trusted https host — the publish
  // block still carries electron-vite's example.com placeholder, and an
  // updater pointed at a domain you do not control is a supply-chain
  // compromise waiting for someone to register it.
  registerUpdater()

  registerTranscription()
  registerCalls()
  registerCoachPdf()
  registerTasks()
  registerContacts()
  registerDeals()
  registerDealStages()
  registerAuth()
  registerEvents()
  registerLiveCue()
  registerLoopbackCapture()
  registerGoogle()
  registerOutlook()
  registerBackup()
  registerVirtualMic()
  registerKnowledge()
  registerObjectionQueue()
  registerAppSettings()
  registerLaunchAtLogin()
  registerActiveApp()
  registerAlerts()
  registerDetectionService()
  writeCrashLog('registrations done', 'all registerX() calls completed, about to createWindow()')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  writeCrashLog('createWindow returned', 'BrowserWindow constructed without throwing')

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Stop any live session before the process exits.
app.on('before-quit', () => {
  disposeTranscription()
  disposeVirtualMic()
  disposeDetectionService()
  disposeOverlay()
  disposeTray()
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
