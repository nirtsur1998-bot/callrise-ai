import { config as loadEnv } from 'dotenv'
import { app, shell, BrowserWindow, session } from 'electron'
import { join, dirname } from 'path'
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Renamed "Sales OS" -> "CallRise AI" (rebrand), but the on-disk data folder
// keeps its original name so existing calls/tasks/settings/consent/Google
// tokens aren't orphaned by the rename. Must run before app is ready.
app.setName('CallRise AI')
const userDataDir = join(app.getPath('appData'), 'sales-os')
app.setPath('userData', userDataDir)

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
    mainWindow = null
  })

  // In development, load the Vite dev server (with hot reload).
  // In production, load the built HTML file.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('ai.callrise.app')

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

  registerTranscription()
  registerCalls()
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

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Stop any live session before the process exits.
app.on('before-quit', () => {
  disposeTranscription()
  disposeVirtualMic()
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
