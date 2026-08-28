// Diagnostic crash log, written with fs.writeFileSync (synchronous — cannot be
// lost to the async-stdout-flush-on-exit race that swallows console output on
// Windows when a process exits immediately after writing to it) to a fixed,
// Electron-readiness-independent path. Registered before every other import so
// it catches a throw from ANY of them, not just from this file's own code.
// TEMPORARY: added to chase a real Windows launch failure that produces zero
// output through every normal channel (console, --enable-logging, Event
// Viewer, WER) - remove once that's root-caused.
import { statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join as joinPathForCrashLog } from 'path'
const crashLogPath = joinPathForCrashLog(tmpdir(), 'callrise-startup-crash.log')
// M29 A1.2: this file had no cap and gained five lines on every launch for
// the life of the machine (docs/M29-audit.md §1.4). Stop appending past 1 MB;
// the persistent, rotated, scrubbed log in log.ts is the real record.
const CRASH_LOG_MAX_BYTES = 1024 * 1024
function writeCrashLog(label: string, err: unknown): void {
  try {
    try {
      if (statSync(crashLogPath).size > CRASH_LOG_MAX_BYTES) return
    } catch {
      /* no file yet — fine */
    }
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
import { app, shell, BrowserWindow, session, dialog, crashReporter } from 'electron'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { DEFAULT_CONFIG } from './default-config'
import { clearActiveConsent } from './consent-gate'
import { registerCrashLogging, registerLog } from './log'
import { captureChildGone, captureRendererGone } from './telemetry/capture'
import { setupTelemetry, recordLaunch, recordQuit } from './telemetry/setup'
import { registerSalesBrainExport } from './memory/export-ipc'
import { registerSupportBundle } from './support-bundle'
import { setIngestConfig, startTelemetrySchedule, stopTelemetrySchedule } from './telemetry/flush'
import { registerTelemetryIpc } from './telemetry/ipc'
import { JobManager, reportPersistFailure } from './jobs/JobManager'
import { hasUsableAiCapacity, hasUsableCapacityForPurpose } from './ai/capacity'
import type { AIPurpose } from './ai/types'
import { registerJobsIpc } from './jobs/ipc'
import { registerFakeJobTypes } from './jobs/fakeJobs'
import { wireJobActivity } from './jobs/activity'
import { setJobManager } from './jobs/instance'
import { Scheduler } from './jobs/scheduler'
import { setScheduler } from './jobs/scheduler-instance'
writeCrashLog('imports resolved', 'all top-level imports completed without throwing')

// Renamed "Sales OS" -> "CallRise AI" (rebrand), but the on-disk data folder
// keeps its original name so existing calls/tasks/settings/consent/Google
// tokens aren't orphaned by the rename. Must run before app is ready.
app.setName('CallRise AI')
const userDataDir = join(app.getPath('appData'), 'sales-os')
app.setPath('userData', userDataDir)

registerCrashLogging()

// M29 A1.3 — make the telemetry front door live. It still writes NOTHING
// unless userData/telemetry-consent.json says 'on' (device-local, never
// backed up — see telemetry/consent.ts for why it is not in app-settings).
setupTelemetry({
  userDataDir,
  appVersion: app.getVersion(),
  crashDumpsDir: app.getPath('crashDumps')
})

// M29 A1.2 — native crash capture, LOCAL ONLY. A hard process death (the
// onnxruntime / better-sqlite3 class of failure that no JS handler ever sees)
// leaves a minidump under app.getPath('crashDumps'). uploadToServer is false
// and there is no submitURL: the dump never leaves the machine — it is
// process memory and could hold a transcript. What opt-in telemetry gets is
// only a COUNT of new dumps at the next launch (telemetry/native-crashes.ts).
// Must run before any renderer or child process is spawned.
try {
  // ⛔ DO NOT SET uploadToServer: true. Not for a debugging session, not
  // "temporarily", not behind a flag.
  //
  // A minidump is a snapshot of PROCESS MEMORY. For this app that memory holds
  // live transcript text, buyer speech, contact and deal records, and any AI
  // provider key currently in use. Flipping this one boolean turns the crash
  // reporter into the single largest content-egress path in the product —
  // larger than telemetry, the support bundle and the diagnostics zip
  // combined, and unlike all three it is not scrubbable: there is no field
  // list to redact, it is raw memory.
  //
  // The M29 correctness audit rated this the highest-consequence single line
  // in the codebase. The dumps are kept locally on purpose; what opt-in
  // telemetry ever learns is a COUNT of new dumps at the next launch
  // (telemetry/native-crashes.ts). If you need the dump itself, read it on the
  // machine that produced it.
  crashReporter.start({ uploadToServer: false, compress: true })
} catch {
  /* a crash reporter that can't start is not worth crashing over */
}

// GPU / utility / network child processes dying is the other crash class
// JavaScript never sees. Counted, never detailed.
app.on('child-process-gone', (_event, details) => {
  captureChildGone(details)
})

// Deep link (M19 Task 3B): callrise://meeting/<eventId> jumps straight to a
// meeting's prep brief — e.g. tapped from a Telegram/email meeting_starting
// alert. In dev, the executable is electron.exe with the project path as an
// argument, so the OS needs to be told to pass this project back as an arg
// on every launch; a packaged build's own exe needs no such hint.
if (!app.isPackaged && process.platform === 'win32') {
  app.setAsDefaultProtocolClient('callrise', process.execPath, [join(__dirname, '..', '..')])
} else {
  app.setAsDefaultProtocolClient('callrise')
}

// Windows/Linux launch a BRAND NEW process for a protocol invocation rather
// than routing it to one already running — without a single-instance lock,
// clicking a callrise:// link while the app is open would silently spawn a
// second, blank window instead of focusing the existing one and showing the
// brief. A second launch loses this race and hands its argv to the first via
// 'second-instance' below, then exits.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  // Calling quit() before whenReady() has resolved aborts this instance's
  // startup entirely (Electron never fires 'ready' for it) — nothing below
  // needs guarding against a losing instance limping partway through setup.
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    // Recovery path for a real, reproduced failure: if the FIRST instance's
    // own startup hung somewhere between whenReady and createWindow() (a
    // registerX() call stuck on a slow network/registry/OS call), it still
    // holds the single-instance lock forever, mainWindow is still null, and
    // — before this fix — every later double-click landed here, matched
    // neither branch below, and did LITERALLY NOTHING: no window, no error,
    // no feedback, launch after launch, until the user found the stuck
    // process in Task Manager and killed it. Only createWindow() (not just
    // app.whenReady().then(createWindow)) needs guarding against a call
    // before 'ready' — Electron throws if a BrowserWindow is constructed too
    // early, and if THAT'S the state we're in, the original startup path
    // will still call createWindow() itself the moment 'ready' actually
    // fires, so there is nothing unsafe to do here except skip this branch.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else if (app.isReady()) {
      createWindow()
    }
    const link = argv.find((arg) => arg.startsWith('callrise://'))
    if (link) handleDeepLink(link)
  })
}

// macOS delivers a protocol launch via this event instead of argv, both for
// a cold start (queued below until the window exists) and while running.
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})

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
// M29 A1.4 — where opt-in telemetry goes: the same Supabase project, via a
// plain fetch with the PUBLIC anon key only (telemetry/transport.ts). Read
// lazily so a developer .env pointing elsewhere is honoured.
setIngestConfig(() => ({
  url: process.env.SUPABASE_URL ?? '',
  anonKey: process.env.SUPABASE_ANON_KEY ?? ''
}))
import icon from '../../resources/icon.png?asset'
import {
  registerTranscription,
  disposeTranscription,
  handleRenderProcessGone
} from './transcription'
import { registerCalls } from './calls'
import { registerTasks } from './tasks'
import { registerContacts } from './contacts'
import { registerDeals } from './deals'
import { registerDealStages } from './deal-stages'
import { registerAuth } from './auth'
import { registerDealTier1 } from './deal-tier1'
import { registerDealTier2 } from './deal-tier2'
import { registerDealFeedback } from './deal-feedback-fs'
import { registerEvents } from './events'
import { registerLiveCue } from './live-cue'
import { registerLoopbackCapture } from './loopback'
import { registerLiveTranscriptIpc } from './live/live-transcript-ipc'
import { redactPendingClosedJournals } from './live/call-journal'
import { registerGoogle } from './google'
import { registerOutlook } from './outlook'
import { registerBackup } from './backup'
import { registerVirtualMic, disposeVirtualMic } from './virtualmic'
import { registerTier1, disposeTier1 } from './tier1'
import { registerTier1Diagnostics } from './tier1-diagnostics'
import { registerKnowledge } from './knowledge'
import { registerObjectionQueue } from './objection-queue'
import {
  registerAppSettings,
  getJobConcurrencySettings,
  setJobConcurrencyChangedListener
} from './app-settings'
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
import { registerFallbackLog } from './ai/fallback-log'
import { registerPurposeHealthStore } from './ai/purpose-health-store'
import { registerModelCatalog } from './ai/catalog-ipc'
import { initSalesBrain, maybeRunNightlyConsolidation } from './memory/memory-runtime'
import { scheduleSalesBrainStartup } from './memory/sales-brain-startup'
import { registerOnboarding } from './memory/onboarding-ipc'
import { registerBackfill } from './memory/backfill-ipc'
import { registerMemoryCenter } from './memory/memory-center-ipc'
import { registerMemoryExtractionJob } from './memory/memory-extraction-job'
import { registerUpdater } from './updater'
import { buildDiagnoseReport, wantsDiagnose } from './diagnose'
import { registerPrepBrief } from './prep-brief-ipc'
import { registerCoachingChat } from './coaching-chat-ipc'
import { registerAssistant } from './assistant/assistant-ipc'
import { registerCrmNoteGenerator } from './crm-note-generator-ipc'
import { registerContactIntelligence } from './contact-intelligence-ipc'

let mainWindow: BrowserWindow | null = null

// M26 — created inside whenReady() below (needs userData, same as every
// other -fs.ts/-ipc.ts module's own storage), read by before-quit further
// down to flush state before the process actually exits.
let jobManager: JobManager | undefined

// Set by handleDeepLink() when it fires before the window exists yet (a cold
// start via the protocol) — flushed once ready-to-show fires below. A send()
// before the renderer has loaded and registered its listener is simply lost,
// so this can't just fire immediately regardless of mainWindow's state.
let pendingDeepLinkEventId: string | null = null

// M27 — set during the registration sequence, fired from 'ready-to-show'
// below so Sales Brain init begins only once the window is actually painted.
// Nullable because createWindow() is also reachable from the 'activate'
// handler on a later relaunch, when startup has long since finished.
let onWindowShown: (() => void) | null = null

function deliverDeepLink(eventId: string): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('prepBrief:openRequested', eventId)
  } else {
    pendingDeepLinkEventId = eventId
  }
}

/** callrise://meeting/<eventId> — the only deep link shape this app defines. */
function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'callrise:' || parsed.hostname !== 'meeting') return
    const eventId = decodeURIComponent(parsed.pathname.replace(/^\//, ''))
    if (eventId) deliverDeepLink(eventId)
  } catch {
    /* malformed deep link — ignore rather than crash on attacker-controlled input */
  }
}

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
    if (pendingDeepLinkEventId) {
      mainWindow?.webContents.send('prepBrief:openRequested', pendingDeepLinkEventId)
      pendingDeepLinkEventId = null
    }
    // M27 — AFTER show(), deliberately. This is the trigger for Sales Brain
    // init, whose first act (openMemoryDb) blocks the main process
    // synchronously. Starting it any earlier than the paint it is waiting
    // for would reintroduce exactly the stall this ordering exists to avoid.
    const notify = onWindowShown
    onWindowShown = null
    notify?.()
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

  // M26 4.4 — the renderer crashed, was OOM-killed, or its GPU process died.
  // Without this a live transcription session just keeps running: nothing
  // else in the app watches for a dead renderer, so the socket stays open
  // (and billing) into a page that no longer exists. See
  // handleRenderProcessGone's own doc comment for why ordering matters.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] render-process-gone: ${details.reason}`)
    captureRendererGone(details) // M29 A1.2 — reason + exit code only; opt-in
    handleRenderProcessGone()
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

  // M26 — created before every other registerX() call below: several of
  // them (starting with Phase 3's adapters, e.g. calls.ts) register their
  // own job type at registration time via jobs/instance.ts's singleton, so
  // the manager has to exist and be set first, not merely before
  // createWindow() (Phase 1/2's original, now too-late, placement).
  jobManager = new JobManager()
  // M27 — quota-pressure deferral. Wired HERE rather than imported inside
  // JobManager, so the job system keeps zero dependency on the AI layer (see
  // setCapacityGate's own doc comment). Holds BATCH/MAINTENANCE work while
  // nothing usable is left to serve it: starting it then would only walk a
  // doomed fallback chain and add retry pressure to a key that live coaching
  // is competing for.
  //
  // The purpose branch is the whole point. A job that declared one is asking
  // about the chain it will really walk; without it, an exhausted
  // memory-extract chain looked like capacity because some unrelated keyed
  // model was fine, and Sales Brain's import ran straight into the scan
  // breaker. Undeclared purposes keep the whole-catalog question.
  jobManager.setCapacityGate((purpose) => {
    // NO_AI_PURPOSE never reaches here — JobManager honours it itself, so
    // the guarantee doesn't depend on this wiring remembering to.
    if (purpose) return hasUsableCapacityForPurpose(purpose as AIPurpose, Date.now())
    return hasUsableAiCapacity(Date.now())
  })
  setJobManager(jobManager)
  registerJobsIpc(jobManager)
  if (is.dev) registerFakeJobTypes(jobManager)
  wireJobActivity(jobManager, () => mainWindow)
  // M26 Phase 5 — same placement reasoning as jobManager above: created
  // before any registerX() that might register a recurring/idle job
  // (memory-runtime.ts's nightly consolidation, so far).
  setScheduler(new Scheduler())

  // M26 Phase 5 — apply the persisted per-lane concurrency override (if
  // any) at startup, and again on every live Settings change. LIVE is
  // deliberately never included — it stays fixed at unbounded, the
  // milestone's own hard rule that a live call must never wait behind
  // anything.
  const applyJobConcurrency = (): void => {
    const c = getJobConcurrencySettings()
    jobManager?.configureLanes({
      INTERACTIVE: { maxConcurrent: c.interactive },
      BATCH: { maxConcurrent: c.batch },
      MAINTENANCE: { maxConcurrent: c.maintenance }
    })
  }
  applyJobConcurrency()
  setJobConcurrencyChangedListener(applyJobConcurrency)

  // Before anything that might use Deepgram/Anthropic — a user's own
  // Settings-entered key (if any) needs to be in process.env first.
  await loadStoredAiKeysIntoEnv()
  registerAiKeys()
  registerModelCatalog()
  registerFallbackLog()
  registerPurposeHealthStore()

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
  // Registers a job type only — no memory access of its own. It must run
  // before registerCalls() below, which can enqueue against it the moment a
  // call is saved, and enqueue() throws on an unregistered type.
  //
  // M27 — this used to also warn that it must not sit behind the
  // initSalesBrain() await further down. There is no longer an await there
  // to sit behind: nothing in the startup sequence waits on Sales Brain at
  // all. Kept here anyway for the enqueue-ordering reason, which stands on
  // its own.
  registerMemoryExtractionJob()
  registerCalls()
  // M26 Phase 4.2 — journaled-call recovery. Registered right after
  // registerCalls because recovery writes a real Call through the same
  // saveCall path, into the same directory.
  registerLiveTranscriptIpc(() => join(app.getPath('userData'), 'calls'))
  // 1.2.5 hotfix (privacy) — one-time-per-launch backlog sweep, redacting
  // buyer content out of any already-closed journal from before this fix
  // shipped (or one whose close-time redaction didn't get to run). Fire-
  // and-forget and NOT awaited: must never sit on the startup critical path
  // to createWindow() — see J2's own lesson about the Sales Brain init race
  // just above. Safe to run every launch regardless: already-redacted
  // journals are skipped instantly via their `.redacted` marker.
  void redactPendingClosedJournals().catch((err) =>
    console.error('[index] pending journal redaction sweep failed:', err)
  )
  registerCoachPdf()
  registerTasks()
  registerContacts()
  registerDeals()
  registerDealStages()
  registerAuth()
  registerDealTier1()
  registerDealTier2()
  registerDealFeedback()
  registerEvents()
  registerLiveCue()
  registerLoopbackCapture()
  registerGoogle()
  registerOutlook()
  registerBackup()

  // M25 — Sales Brain init used to run right at the top of this function,
  // awaited, before registerAuth() ever ran. On at least one real machine it
  // stalled for tens of seconds (~48s observed) - most likely downloading the
  // local embeddings model on first real use - which meant registerAuth()
  // hadn't registered its IPC handler yet by the time the already-loaded
  // renderer asked for auth status. The renderer's fallback for "no handler
  // yet" reads identically to "Supabase isn't configured," so users saw a
  // false "Accounts aren't set up yet" screen that had nothing to do with
  // their actual account. It then moved here, behind everything else, capped
  // by a 15s Promise.race.
  //
  // M27 — that cap could not fire (taxonomy species 15). Promise.race
  // evaluates left to right, so initSalesBrain() ran to its first real await
  // BEFORE the 15s timer was armed, and openMemoryDb() is fully synchronous:
  // two native-module require()s, the DB open, a WAL pragma, an extension
  // load. Since createWindow() sat below this await, the stall the cap
  // existed to survive produced NO WINDOW AT ALL. Proven, not inferred: a
  // 500ms cap around a 3000ms synchronous block takes the full 3000ms.
  //
  // Init is now scheduled to begin only once the window is actually on
  // screen, and nightly consolidation chains behind it (it early-returns on a
  // null db, so calling it any sooner would silently skip consolidation for
  // the whole session). See sales-brain-startup.ts, which exists to make this
  // ordering testable at all — nothing in the suite can import this file.
  //
  // The three registrations below no longer wait on it. They never actually
  // needed to: `db` is assigned only AFTER migrate() succeeds, so a handler
  // firing mid-migration reads null - never a half-upgraded database - and
  // all three already handle a null db (onboarding and backfill via
  // ensureMemoryDb(), which retries a failed/slow init at exactly these
  // user-facing entry points). The old ordering was belt-and-braces; the
  // late assignment of `db` is the real guarantee.
  onWindowShown = scheduleSalesBrainStartup({
    init: initSalesBrain,
    afterInit: maybeRunNightlyConsolidation
  }).windowReady

  registerOnboarding()
  registerBackfill()
  registerMemoryCenter()
  registerSalesBrainExport() // M29 A5.3
  registerSupportBundle() // M29 A5.4
  registerVirtualMic()
  // M27 — Tier 1: driver-free noise cancellation for CallRise's own call
  // audio (Windows). Deliberately separate from registerVirtualMic() above,
  // which is the macOS Core-Audio-driver design — different platform,
  // different architecture (an out-of-band named pipe here, not a capture
  // device), no shared state between them.
  registerTier1()
  registerTier1Diagnostics()
  registerKnowledge()
  registerObjectionQueue()
  registerAppSettings()
  registerLaunchAtLogin()
  registerActiveApp()
  registerLog()
  registerTelemetryIpc() // M29 A1.3
  registerAlerts()
  registerPrepBrief()
  registerCoachingChat()
  registerAssistant()
  registerCrmNoteGenerator()
  registerContactIntelligence()
  registerDetectionService()

  writeCrashLog('registrations done', 'all registerX() calls completed, about to createWindow()')

  // A cold start via callrise://meeting/<id> on Windows/Linux — the URL
  // arrives as a regular argv entry, not the 'open-url' event (macOS-only).
  const argvDeepLink = process.argv.find((arg) => arg.startsWith('callrise://'))
  if (argvDeepLink) handleDeepLink(argvDeepLink)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()
  writeCrashLog('createWindow returned', 'BrowserWindow constructed without throwing')
  // M29 A1.3 — with consent on: count native dumps since last launch, mark
  // the session started. With consent off/unasked: a no-op, by construction.
  recordLaunch()
  startTelemetrySchedule() // 30 s after launch, then every 6 h; no-op unless consent is on

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// M26 Phase 2 — the quit guard. Set once a quit is genuinely going ahead
// (nothing was running, or the rep chose "Cancel and quit"), so the SECOND
// before-quit firing (from this handler's own app.quit() call below) skips
// straight to teardown instead of asking again.
let quitConfirmed = false

app.on('before-quit', (event) => {
  if (quitConfirmed) {
    recordQuit() // M29 A1.3 — a clean end; its absence is what 'crashed' means
    stopTelemetrySchedule()
    disposeTranscription()
    disposeVirtualMic()
    disposeTier1()
    disposeDetectionService()
    disposeOverlay()
    disposeTray()
    jobManager?.dispose()
    // Same reason as the throttled auto-save inside JobManager: nobody awaits
    // this, so an unhandled rejection here is the only thing a failed
    // final write would produce. Quit proceeds either way — a job queue we
    // couldn't persist must never block the app from closing (BUG-070).
    void jobManager?.flush().catch(reportPersistFailure)
    return
  }

  const active =
    jobManager?.list().filter((j) => j.state === 'running' || j.state === 'queued') ?? []
  if (active.length === 0) {
    quitConfirmed = true
    return // nothing to guard against — let this same event proceed normally
  }

  event.preventDefault()
  const count = active.length
  const options = {
    type: 'question' as const,
    buttons: [`Wait for ${count} job${count === 1 ? '' : 's'}`, 'Cancel and quit'],
    defaultId: 0,
    cancelId: 0,
    message: `${count} background job${count === 1 ? ' is' : 's are'} still running.`,
    // BUG-054 — this used to read "a live call is saved first either way",
    // which is false: nothing in before-quit asks the renderer to save an
    // in-progress call, and a quit mid-call loses it entirely. Telling the
    // rep their call is safe at the exact moment it is being destroyed is
    // worse than saying nothing. The honest warning stands until Phase 4's
    // incremental journaling actually makes a mid-call quit survivable, at
    // which point this copy should change to match the new truth.
    detail:
      'Quitting now stops them. A call still in progress is NOT saved — stop the call first if you want to keep it. Backup/maintenance work gets a few seconds to finish on its own.'
  }
  const choice = mainWindow
    ? dialog.showMessageBoxSync(mainWindow, options)
    : dialog.showMessageBoxSync(options)
  if (choice === 0) return // "Wait" — stay open, nothing else to do here

  // "Cancel and quit": stop everything cancellable right away, but give
  // MAINTENANCE-lane work (e.g. a backup already mid-write) a short grace
  // window to finish on its own rather than yanking it mid-flight.
  for (const job of active) {
    if (job.lane !== 'MAINTENANCE') jobManager?.cancel(job.id)
  }
  const graceDeadline = Date.now() + 3000
  const tryQuit = (): void => {
    const stillFinishing =
      jobManager
        ?.list()
        .some((j) => j.lane === 'MAINTENANCE' && (j.state === 'running' || j.state === 'queued')) ??
      false
    if (!stillFinishing || Date.now() >= graceDeadline) {
      quitConfirmed = true
      app.quit()
      return
    }
    setTimeout(tryQuit, 250)
  }
  tryQuit()
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
