// BUG-026 / BUG-027 — active-app.ts's "known calling app" heuristic is a
// lightweight broadcast layered on the same blur/focus poll used for the AI
// Note Taker exclusion list. Two separate defects lived here:
//
//   BUG-026: stopSampling() (fired on browser-window-focus, i.e. the rep
//   tabbing back into CallRise AI) didn't cancel a sampleExternalApp() call
//   already in flight from the immediate check startSampling() fires on
//   blur. A lookup resolving AFTER refocus still ran unconditionally —
//   capable of broadcasting a stale "call detected" for a call that, from
//   the rep's point of view, never happened.
//
//   BUG-027: the broadcast itself ignored BOTH the master ambient-detection
//   switch (off by default) and any per-app "Never ask" override, unlike the
//   FSM-based detector (detection-service.ts), which always checks both.
//
// Drives this through the REAL Electron event wiring (capturing the
// `browser-window-blur`/`browser-window-focus` handlers registerActiveApp()
// installs via app.on), rather than exporting internal functions just for
// the test, so this proves the actual production wiring.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers: Record<string, () => void> = {}
const sendMock = vi.fn()

vi.mock('electron', () => ({
  app: {
    getName: () => 'CallRise AI',
    on: (event: string, handler: () => void) => {
      handlers[event] = handler
    }
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: sendMock } }]
  },
  systemPreferences: { isTrustedAccessibilityClient: () => true }
}))

// Deferred so the test controls exactly when the "frontmost app" lookup
// resolves relative to the simulated refocus.
let resolveActiveWin: ((v: { owner: { name: string } }) => void) | null = null
vi.mock('active-win', () => ({
  default: vi.fn(
    () =>
      new Promise((resolve) => {
        resolveActiveWin = resolve
      })
  )
}))

vi.mock('../known-calling-apps', () => ({
  isKnownCallingApp: (name: string) => name === 'WhatsApp'
}))

let detectionEnabled = true
let appOverrides: Record<string, string> = {}
vi.mock('../app-settings', () => ({
  isAmbientDetectionEnabled: () => detectionEnabled,
  loadAppSettings: () => ({
    detection: {
      enabled: detectionEnabled,
      capturePolicy: { autoCapturePolicy: 'mic-only', appOverrides }
    }
  })
}))

// BUG-141 — WARM THE MODULE GRAPH HERE, at collection time, rather than inside
// whichever `it()` happens to import first.
//
// `vi.resetModules()` clears the executed-module registry but NOT vitest's
// fetch/transform cache. So the FIRST test to import pays the COLD fetch —
// served by the single vite transform server that every worker process in the
// run shares — inside its own 20 s budget, while all the later tests
// re-execute an already-fetched graph in tens of milliseconds. That is why the
// failures were always the first `it()` in the file, and why they were stalls
// rather than slowness: a queue on a shared serialized resource.
//
// Measured 2026-09-09 under 3x suite load, on assistant-ipc.turn.test.ts:
// the first test's import phase went 2396 ms -> 7 ms with this line present.
//
// This does NOT make the pipeline faster. It stops shared-infrastructure
// latency being charged to one test's per-test timeout, which is the actual
// defect. Deleting it as a "redundant import" reopens BUG-141 for this file;
// the dynamic import below is still needed, for module isolation.
//
// This carries two limits — it makes nothing faster, and collection has no
// timeout so a genuinely hung fetch now hangs the file instead of failing one
// test. Both are spelled out at the same block in
// src/main/assistant/__tests__/assistant-ipc.turn.test.ts.
await import('../active-app')

async function blurThenResolve(name: string): Promise<void> {
  handlers['browser-window-blur']()
  expect(resolveActiveWin).not.toBeNull()
  resolveActiveWin!({ owner: { name } })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('active-app blur/focus race and detection-settings gate', () => {
  beforeEach(() => {
    vi.resetModules()
    sendMock.mockClear()
    resolveActiveWin = null
    detectionEnabled = true
    appOverrides = {}
  })

  afterEach(() => {
    // Stop the real setInterval registerActiveApp() started, so it doesn't
    // keep firing (and keep the process alive) after the test ends.
    handlers['browser-window-focus']?.()
  })

  it('BUG-026: does not broadcast a call-detected event from a lookup that resolves after refocus', async () => {
    const { registerActiveApp } = await import('../active-app')
    registerActiveApp()

    // Rep tabs away to WhatsApp — this kicks off the immediate sample.
    handlers['browser-window-blur']()
    // Rep is back in CallRise AI before the OS-level lookup has answered —
    // stopSampling() runs while sampleExternalApp()'s await is still pending.
    handlers['browser-window-focus']()

    expect(resolveActiveWin).not.toBeNull()
    resolveActiveWin!({ owner: { name: 'WhatsApp' } })
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('still broadcasts normally when the lookup resolves before any refocus', async () => {
    const { registerActiveApp } = await import('../active-app')
    registerActiveApp()

    await blurThenResolve('WhatsApp')

    expect(sendMock).toHaveBeenCalledWith('app:callDetected', 'WhatsApp')
  })

  it('BUG-027: does not broadcast when ambient detection is off, even for a known calling app', async () => {
    detectionEnabled = false
    const { registerActiveApp } = await import('../active-app')
    registerActiveApp()

    await blurThenResolve('WhatsApp')

    expect(sendMock).not.toHaveBeenCalled()
  })

  it("BUG-027: does not broadcast when this app's override is 'never'", async () => {
    appOverrides = { whatsapp: 'never' }
    const { registerActiveApp } = await import('../active-app')
    registerActiveApp()

    await blurThenResolve('WhatsApp')

    expect(sendMock).not.toHaveBeenCalled()
  })

  it("still broadcasts when another app's override is 'never' but this one has none", async () => {
    appOverrides = { zoom: 'never' }
    const { registerActiveApp } = await import('../active-app')
    registerActiveApp()

    await blurThenResolve('WhatsApp')

    expect(sendMock).toHaveBeenCalledWith('app:callDetected', 'WhatsApp')
  })
})
