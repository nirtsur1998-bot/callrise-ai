import { config as loadEnv } from 'dotenv'
loadEnv()

import { app, shell, BrowserWindow, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerTranscription, disposeTranscription } from './transcription'
import { registerCalls } from './calls'
import { registerTasks } from './tasks'
import { registerAuth } from './auth'

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
  electronApp.setAppUserModelId('com.salesos.app')

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
  registerAuth()

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
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
