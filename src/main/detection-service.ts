// Main-process glue for ambient call detection (M15 Phases 4-5): owns the one
// CallDetector instance, turns its events into policy decisions
// (detected -> policy.decideCaptureAction -> start/ask/ignore), drives the
// live-capture overlay window (banner/toast/switch-prompt) and the tray icon,
// and exposes the renderer-facing IPC surface. Gated end-to-end behind the
// ff_ambient_detection feature flag (app-settings.ts's `detection.enabled`,
// default OFF) - with it off, this module never starts an adapter and every
// handler is a no-op.
//
// Capture itself is still renderer-initiated (getUserMedia/getDisplayMedia
// live in src/renderer/src/features/live/audio/recorder.ts; there is no
// main-process audio API) - a `start` decision here only broadcasts
// `detection:startCapture` and waits for MainApp's ack (see
// MainApp.tsx/LiveView.tsx's ambientAutoStart wiring). Pause/Stop requested
// from the overlay banner or the tray menu work the same way: broadcast a
// request, the main window's LiveView is the one that actually calls
// stop()/togglePause().
import { BrowserWindow, ipcMain } from 'electron'
import {
  isAmbientDetectionEnabled,
  loadAppSettings,
  setDetectionEnabledChangedListener
} from './app-settings'
import { CONFERENCING_APPS } from './detection/appRegistry'
import { CallDetector } from './detection/CallDetector'
import { MacAdapter } from './detection/adapters/MacAdapter'
import { NullAdapter } from './detection/adapters/NullAdapter'
import { WindowsAdapter } from './detection/adapters/WindowsAdapter'
import {
  disableOverlayShortcuts,
  enableOverlayShortcuts,
  hideOverlay,
  initOverlay,
  showOverlay
} from './detection-overlay'
import { disposeTray, registerDetectionTray, updateTray } from './detection-tray'
import { decideCaptureAction, type CaptureAction } from './detection/policy'
import type { ICallDetectorAdapter } from './detection/adapters/ICallDetectorAdapter'
import { DETECTION_TUNING, type DetectedCall, type DetectorEvent } from './detection/types'

function pickAdapter(): ICallDetectorAdapter {
  if (process.platform === 'darwin') return new MacAdapter()
  if (process.platform === 'win32') return new WindowsAdapter()
  return new NullAdapter()
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

let detector: CallDetector | null = null
let mainWindowRef: BrowserWindow | null = null
/** Whether the detector is actually running right now - distinct from the
 *  ff_ambient_detection setting, since Pause/Resume (tray/overlay) toggle
 *  this without touching the persisted setting. */
let running = false

/** Calls we've already run a policy decision for - a switch or a natural end-while-pending
 *  lands the FSM back in 'detected' WITHOUT a fresh 'call-detected' event, so this dedupes
 *  against re-deciding (and re-prompting) for the same call twice. */
const handledCallIds = new Set<string>()
/** The mode we decided on `detection:startCapture`, looked up when the renderer's ack arrives. */
const pendingStartModes = new Map<string, 'full' | 'mic-only'>()
/** The one 'ask' policy toast currently up, if any, and its auto-dismiss timer. */
let pendingAskCallId: string | null = null
let askTimeout: ReturnType<typeof setTimeout> | undefined

function clearAskTimeout(): void {
  clearTimeout(askTimeout)
  askTimeout = undefined
}

const trayActions = {
  openMainWindow: () => openMainWindow(),
  pauseDetection: () => pauseDetection(),
  resumeDetection: () => resumeDetection(),
  stopCapture: () => stopCapture(),
  snoozeDetection: (minutes: number) => snoozeDetection(minutes),
  isRunning: () => running
}

/**
 * The tray icon's existence tracks the ff_ambient_detection SETTING (not the
 * transient `running`/paused state) - pausing detection via the tray must
 * only change its label/menu, never make the tray icon (and its own Resume
 * item) disappear. Everyone with the feature off keeps zero footprint: no
 * new persistent tray icon just because this milestone's code exists. The
 * overlay's right-click menu + global shortcuts (Cmd/Ctrl+Shift+S/P) follow
 * the exact same rule, for the exact same reason.
 */
function syncTrayPresence(): void {
  if (isAmbientDetectionEnabled()) {
    registerDetectionTray(trayActions)
    enableOverlayShortcuts()
  } else {
    disposeTray()
    disableOverlayShortcuts()
  }
}

/** The overlay window + tray are refreshed together, every time - whenever anything relevant changes. */
function syncUi(): void {
  const state = detector?.getState()
  const showingCapture =
    state?.name === 'capturing' ||
    state?.name === 'capturing-with-pending' ||
    state?.name === 'ending'
  if (showingCapture || pendingAskCallId != null) showOverlay()
  else hideOverlay()
  updateTray({ running, stateName: state?.name }, trayActions)
}

function evaluateDetectedCall(call: DetectedCall): void {
  if (handledCallIds.has(call.id)) return
  handledCallIds.add(call.id)

  const settings = loadAppSettings().detection.capturePolicy
  // A call can never already have consent at the instant it's first detected -
  // per-call consent (M11/M12) is only ever granted mid-call through the
  // existing, UNCHANGED consent modal. So 'full' policy always resolves to
  // mic-only here; the live consent flow is what upgrades a session to full
  // once the rep gets a "yes" - this file never re-implements that decision.
  const action: CaptureAction = decideCaptureAction(call.appId, settings, {
    canRecordOtherParty: false
  })

  if (action.type === 'ignore') return
  if (action.type === 'ask-user') {
    pendingAskCallId = call.id
    broadcast('detection:call-detected', call)
    clearAskTimeout()
    askTimeout = setTimeout(() => {
      if (pendingAskCallId !== call.id) return
      pendingAskCallId = null
      detector?.applyCommand({ type: 'decline-detection' })
      syncUi()
    }, DETECTION_TUNING.detectionToastTimeoutMs)
    syncUi()
    return
  }
  pendingStartModes.set(call.id, action.mode)
  broadcast('detection:startCapture', { call, mode: action.mode })
}

/** Runs after every FSM tick - catches the 'detected' state however we arrived at it (a
 *  fresh call-detected event, a switch, or the original call ending while a switch was pending). */
function checkForNewDetection(): void {
  const state = detector?.getState()
  if (state?.name === 'detected') evaluateDetectedCall(state.call)
}

function handleDetectorEvent(event: DetectorEvent): void {
  broadcast('detection:state-changed', { state: detector?.getState() })
  broadcast('detection:event', event)

  // The detector deciding a call is over has to actually END the recording.
  //
  // It did not before: the FSM emitted `capture-ended` and every UI surface
  // updated to say "not capturing", while the microphone and the Deepgram
  // session kept running until someone opened the app and pressed Stop. The
  // call was never saved either, since the save only fires when the session
  // closes. Only the MANUAL stops went through stopCapture(), which is what
  // does both halves — so the one path nobody drives by hand was the one that
  // never stopped anything.
  //
  // 'user-stopped' is excluded because it arrives FROM stopCapture(), which
  // has already broadcast; re-broadcasting would be harmless but dishonest
  // about where the request came from.
  if (event.type === 'capture-ended' && event.reason !== 'user-stopped') {
    broadcast('detection:requestStopCapture', undefined)
  }
  if (event.type === 'switch-offered') {
    broadcast('detection:switch-offered', { current: event.current, pending: event.pending })
  }
  if (
    (event.type === 'capture-started' || event.type === 'call-lost') &&
    pendingAskCallId === event.call.id
  ) {
    clearAskTimeout()
    pendingAskCallId = null
  }
  checkForNewDetection()
  syncUi()
}

function openMainWindow(): void {
  mainWindowRef?.show()
  mainWindowRef?.focus()
}

function pauseDetection(): void {
  detector?.stop()
  running = false
  syncUi()
}

function resumeDetection(): void {
  detector?.start()
  running = true
  syncUi()
}

function stopCapture(): void {
  // Both halves of "stop", always together: tell the FSM the capture ended
  // AND tell the renderer to actually stop the mic/Deepgram session. Each UI
  // surface (tray, overlay banner) only used to do one half - the tray's
  // "Stop capturing" left the real recording running silently, and the
  // overlay's Stop button left the FSM/tray/banner stuck showing a live
  // capture that had already stopped.
  detector?.applyCommand({ type: 'stop' })
  broadcast('detection:requestStopCapture', undefined)
  syncUi()
}

let snoozeTimer: ReturnType<typeof setTimeout> | undefined
function snoozeDetection(minutes: number): void {
  pauseDetection()
  clearTimeout(snoozeTimer)
  snoozeTimer = setTimeout(() => resumeDetection(), Math.max(1, minutes) * 60_000)
}

export function startDetectionService(): void {
  if (detector) return
  detector = new CallDetector({ adapter: pickAdapter(), ourPid: process.pid })
  detector.onEvent(handleDetectorEvent)
  if (isAmbientDetectionEnabled()) {
    detector.start()
    running = true
  }
  setDetectionEnabledChangedListener(refreshDetectionServiceEnablement)
  // Pre-creates the (hidden) overlay window now, regardless of whether the
  // feature ends up enabled — see initOverlay()'s own comment for why this
  // beats creating it lazily on first real detection.
  initOverlay(trayActions)
  syncTrayPresence()
}

export function stopDetectionService(): void {
  detector?.stop()
  detector = null
  running = false
  handledCallIds.clear()
  pendingStartModes.clear()
  clearAskTimeout()
  clearTimeout(snoozeTimer)
  pendingAskCallId = null
  hideOverlay()
  disposeTray()
}

/** Call after a settings change flips `detection.enabled` - the Settings toggle wires to this via app-settings.ts. */
export function refreshDetectionServiceEnablement(): void {
  if (!detector) return
  if (isAmbientDetectionEnabled()) {
    detector.start()
    running = true
  } else {
    detector.stop()
    running = false
  }
  syncTrayPresence()
  syncUi()
}

/** So the overlay's/tray's "Open CallRise AI" action (and future main-window-targeted actions) can reach the real app window. */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

/**
 * Call when the main window closes - if a capture was in progress, ends it
 * the same way any other Stop does (FSM command + renderer broadcast, via
 * stopCapture()). Without this, closing the window mid-capture left the FSM
 * stuck in 'capturing' forever: the overlay (a separate, independent window)
 * kept showing a live capture banner with dead Stop/Pause buttons (their
 * requests broadcast to BrowserWindow.getAllWindows(), which no longer
 * included the destroyed main window), and no new call could be tracked
 * since only 'idle' starts a fresh candidate.
 */
export function handleMainWindowClosed(): void {
  const state = detector?.getState()
  const wasCapturing =
    state?.name === 'capturing' ||
    state?.name === 'capturing-with-pending' ||
    state?.name === 'ending'
  if (wasCapturing) stopCapture()
}

export function registerDetectionService(): void {
  startDetectionService()
  syncUi()

  ipcMain.handle(
    'detection:captureStarted',
    (_event, payload: { callId: string; sessionId: string }) => {
      const mode = pendingStartModes.get(payload.callId) ?? 'mic-only'
      pendingStartModes.delete(payload.callId)
      // callId ties this ack to the call it was decided for - if the FSM has
      // since moved on to a different call (this one's signals faded during a
      // slow mic-permission prompt, and a new one was detected meanwhile), the
      // FSM itself rejects a mismatched callId rather than misapplying a stale
      // ack to whatever call currently occupies 'detected'.
      detector?.applyCommand({
        type: 'start-capture',
        callId: payload.callId,
        sessionId: payload.sessionId,
        mode
      })
      syncUi()
    }
  )

  ipcMain.handle('detection:captureFailed', (_event, payload: { callId: string }) => {
    pendingStartModes.delete(payload.callId)
    detector?.applyCommand({ type: 'error' })
    syncUi()
  })

  ipcMain.handle('detection:respondToDetection', (_event, decision: 'accept' | 'decline') => {
    if (decision === 'decline') {
      clearAskTimeout()
      pendingAskCallId = null
      detector?.applyCommand({ type: 'decline-detection' })
    } else {
      const state = detector?.getState()
      if (state?.name === 'detected') {
        clearAskTimeout()
        pendingAskCallId = null
        pendingStartModes.set(state.call.id, 'mic-only')
        broadcast('detection:startCapture', { call: state.call, mode: 'mic-only' })
      }
    }
    syncUi()
  })

  ipcMain.handle('detection:respondToSwitch', (_event, decision: 'switch' | 'keep') => {
    detector?.applyCommand({ type: 'respond-to-switch', decision })
    syncUi()
  })

  ipcMain.handle('detection:pause', () => pauseDetection())
  ipcMain.handle('detection:resume', () => resumeDetection())
  ipcMain.handle('detection:stop', () => stopCapture())
  ipcMain.handle('detection:snooze', (_event, minutes: number) => snoozeDetection(minutes))

  ipcMain.handle('detection:getState', () => detector?.getState())

  // For Settings' per-app override editor - id+displayName only, so the
  // renderer (which can't import main/detection/appRegistry.ts directly,
  // different tsconfig) always matches the exact appIds policy.ts checks.
  ipcMain.handle('detection:getKnownApps', () =>
    CONFERENCING_APPS.map((a) => ({ appId: a.appId, displayName: a.displayName }))
  )

  // Overlay banner actions that need the MAIN window/session, not this module.
  ipcMain.handle('detection:openMainWindow', () => openMainWindow())
  // Reuses stopCapture() - both the FSM command AND the renderer broadcast,
  // same as the tray's "Stop capturing" - so however the user stops a
  // capture, the FSM and the real session always end together.
  ipcMain.handle('detection:requestStopCapture', () => stopCapture())
  // Pause has no FSM-side state (the FSM tracks "capturing" regardless of
  // whether the underlying recording is paused) - just forward the request.
  ipcMain.handle('detection:requestTogglePause', () =>
    broadcast('detection:requestTogglePause', undefined)
  )
}

export function disposeDetectionService(): void {
  stopDetectionService()
}
