// Persistent app-error log for support requests — separate from the
// TEMPORARY startup crash log at the top of index.ts (which exists only to
// catch failures before app.getPath('userData') is even set). This one
// covers the app's whole running life, in both processes, and is meant to be
// small enough to attach to an email.

import { app, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { scrub } from './telemetry/scrub'
import { captureError } from './telemetry/capture'

const MAX_BYTES = 2 * 1024 * 1024 // 2MB — stays email-attachable even after rotation

function logDir(): string {
  const dir = join(app.getPath('userData'), 'logs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function logFilePath(): string {
  return join(logDir(), 'callrise.log')
}

/** Keeps exactly one rotated file (`callrise.old.log`) so total size is bounded. */
function rotateIfNeeded(path: string): void {
  if (!existsSync(path)) return
  if (statSync(path).size <= MAX_BYTES) return
  const rotated = path.replace(/\.log$/, '.old.log')
  try {
    renameSync(path, rotated)
  } catch {
    // best-effort — a failed rotation just means this file grows a bit more
  }
}

// M29 A1.0 — every line passes through the scrubber HERE, at the one place
// bytes reach disk, so no caller (logError, logInfo, the renderer forwarder)
// can forget. Before this, every stack trace in this file carried the Windows
// username via C:\Users\<name>\… (docs/M29-audit.md §1.4). This file is the
// one a user emails to support, so it is an egress, not just a local file.
function appendLine(line: string): void {
  try {
    const path = logFilePath()
    rotateIfNeeded(path)
    const safe = scrub(line)
    // The scrubber caps very long strings; keep one record per line regardless.
    writeFileSync(path, safe.endsWith('\n') ? safe : `${safe}\n`, { flag: 'a' })
  } catch {
    // logging must never throw into the caller
  }
}

export function logError(scope: string, err: unknown, extra?: Record<string, unknown>): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  const extraStr = extra ? ` ${JSON.stringify(extra)}` : ''
  appendLine(`[${new Date().toISOString()}] ERROR ${scope}: ${detail}${extraStr}\n`)
}

export function logInfo(scope: string, message: string): void {
  appendLine(`[${new Date().toISOString()}] INFO ${scope}: ${message}\n`)
}

let crashHandlersRegistered = false

/**
 * The one handler for a main-process uncaught exception / unhandled
 * rejection: the local log line (as before) PLUS an opt-in telemetry event
 * (M29 A1.2). Exported so tests can drive it without emitting a real
 * 'uncaughtException' into the test runner.
 */
export function onMainProcessError(
  scope: 'main:uncaughtException' | 'main:unhandledRejection',
  err: unknown
): void {
  logError(scope, err)
  captureError(scope, err)
}

/** Call once, after app.getPath('userData') is set. Safe to call multiple times. */
export function registerCrashLogging(): void {
  if (crashHandlersRegistered) return
  crashHandlersRegistered = true
  process.on('uncaughtException', (err) => onMainProcessError('main:uncaughtException', err))
  process.on('unhandledRejection', (err) => onMainProcessError('main:unhandledRejection', err))
}

/** IPC surface: lets Settings show/open the log file, and lets the renderer report its own errors. */
export function registerLog(): void {
  ipcMain.handle('app:getLogsPath', (): string => logFilePath())
  ipcMain.handle('app:openLogsFolder', (): void => {
    rotateIfNeeded(logFilePath())
    if (!existsSync(logFilePath())) writeFileSync(logFilePath(), '')
    shell.showItemInFolder(logFilePath())
  })
  ipcMain.handle('app:logRendererError', (_event, scope: unknown, message: unknown): void => {
    if (typeof scope !== 'string' || typeof message !== 'string') return
    onRendererError(scope, message)
  })
}

/** Renderer-side error forwarded over IPC (window.onerror / unhandledrejection / ErrorBoundary). */
export function onRendererError(scope: string, message: string): void {
  logError(`renderer:${scope}`, message)
  // The renderer sends a stack-or-message string; captureError keeps only the
  // `at …` frames of it, so a message-only report contributes class + scope.
  captureError(`renderer:${scope}`, message)
}
