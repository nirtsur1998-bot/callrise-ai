// Main-process glue for ambient call detection (M15 Phase 4): owns the one
// CallDetector instance, turns its events into policy decisions
// (detected -> policy.decideCaptureAction -> start/ask/ignore), and exposes
// the renderer-facing IPC surface. Gated end-to-end behind the ff_ambient_detection
// feature flag (app-settings.ts's `detection.enabled`, default OFF) - with it
// off, this module never starts an adapter and every handler is a no-op.
//
// IMPORTANT - what this file does NOT do yet: it cannot itself start audio
// capture. Capture is renderer-initiated today (getUserMedia/getDisplayMedia
// live in src/renderer/src/features/live/audio/recorder.ts; there is no
// main-process audio API - see transcription.ts). So a `start` decision here
// only broadcasts `detection:startCapture` to the renderer and waits for an
// ack; nothing listens for that event yet. See docs/detection.md for the
// open architecture question (which session ambient-triggered capture shares
// with the manual Live Calls flow) that Phase 5's UI work needs to resolve
// before this does anything a user can see.
import { BrowserWindow, ipcMain } from 'electron'
import { isAmbientDetectionEnabled, loadAppSettings } from './app-settings'
import { CONFERENCING_APPS } from './detection/appRegistry'
import { CallDetector } from './detection/CallDetector'
import { MacAdapter } from './detection/adapters/MacAdapter'
import { NullAdapter } from './detection/adapters/NullAdapter'
import { WindowsAdapter } from './detection/adapters/WindowsAdapter'
import { decideCaptureAction, type CaptureAction } from './detection/policy'
import type { ICallDetectorAdapter } from './detection/adapters/ICallDetectorAdapter'
import type { DetectedCall, DetectorEvent } from './detection/types'

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
/** Calls we've already run a policy decision for - a switch or a natural end-while-pending
 *  lands the FSM back in 'detected' WITHOUT a fresh 'call-detected' event, so this dedupes
 *  against re-deciding (and re-prompting) for the same call twice. */
const handledCallIds = new Set<string>()
/** The mode we decided on `detection:startCapture`, looked up when the renderer's ack arrives. */
const pendingStartModes = new Map<string, 'full' | 'mic-only'>()

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
    broadcast('detection:call-detected', call)
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
  if (event.type === 'switch-offered') {
    broadcast('detection:switch-offered', { current: event.current, pending: event.pending })
  }
  checkForNewDetection()
}

export function startDetectionService(): void {
  if (detector) return
  detector = new CallDetector({ adapter: pickAdapter(), ourPid: process.pid })
  detector.onEvent(handleDetectorEvent)
  if (isAmbientDetectionEnabled()) detector.start()
}

export function stopDetectionService(): void {
  detector?.stop()
  detector = null
  handledCallIds.clear()
  pendingStartModes.clear()
}

/** Call after a settings change flips `detection.enabled` - Phase 5's Settings toggle wires to these. */
export function refreshDetectionServiceEnablement(): void {
  if (!detector) return
  if (isAmbientDetectionEnabled()) detector.start()
  else detector.stop()
}

export function registerDetectionService(): void {
  startDetectionService()

  ipcMain.handle(
    'detection:captureStarted',
    (_event, payload: { callId: string; sessionId: string }) => {
      const mode = pendingStartModes.get(payload.callId) ?? 'mic-only'
      pendingStartModes.delete(payload.callId)
      detector?.applyCommand({ type: 'start-capture', sessionId: payload.sessionId, mode })
    }
  )

  ipcMain.handle('detection:captureFailed', (_event, payload: { callId: string }) => {
    pendingStartModes.delete(payload.callId)
    detector?.applyCommand({ type: 'error' })
  })

  ipcMain.handle('detection:respondToDetection', (_event, decision: 'accept' | 'decline') => {
    if (decision === 'decline') {
      detector?.applyCommand({ type: 'decline-detection' })
      return
    }
    const state = detector?.getState()
    if (state?.name === 'detected') {
      pendingStartModes.set(state.call.id, 'mic-only')
      broadcast('detection:startCapture', { call: state.call, mode: 'mic-only' })
    }
  })

  ipcMain.handle('detection:respondToSwitch', (_event, decision: 'switch' | 'keep') => {
    detector?.applyCommand({ type: 'respond-to-switch', decision })
  })

  ipcMain.handle('detection:pause', () => detector?.stop())
  ipcMain.handle('detection:resume', () => detector?.start())
  ipcMain.handle('detection:stop', () => detector?.applyCommand({ type: 'stop' }))
  ipcMain.handle('detection:snooze', (_event, minutes: number) => {
    detector?.stop()
    setTimeout(() => detector?.start(), Math.max(1, minutes) * 60_000)
  })

  ipcMain.handle('detection:getState', () => detector?.getState())

  // For Settings' per-app override editor - id+displayName only, so the
  // renderer (which can't import main/detection/appRegistry.ts directly,
  // different tsconfig) always matches the exact appIds policy.ts checks.
  ipcMain.handle('detection:getKnownApps', () =>
    CONFERENCING_APPS.map((a) => ({ appId: a.appId, displayName: a.displayName }))
  )
}

export function disposeDetectionService(): void {
  stopDetectionService()
}
