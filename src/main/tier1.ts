// M27 — Tier 1: driver-free noise cancellation for CallRise's OWN call audio.
//
// A companion engine (kern_bridge.exe, built and shipped separately — see
// resolveEnginePath()) captures the real microphone via WASAPI, denoises it
// with DeepFilterNet3, and serves the clean audio over a named pipe. This
// module is the pipe CLIENT: it connects, reads raw PCM, converts it to the
// Float32 shape the renderer's Web Audio graph wants, and forwards it.
//
// Deliberately OUT-OF-BAND from getUserMedia. The obvious-looking
// alternative — publish the denoised audio as a virtual capture device and
// just select it — was tried on this codebase's macOS sibling feature and
// rejected: a virtual device emits true digital silence whenever nothing is
// actively pushing to it, and this app's own self-capture guard exists
// specifically to refuse selecting exactly that kind of device (see
// isCallRiseMic() in devices.ts). Delivering audio over a pipe sidesteps the
// whole problem: there is no device to accidentally select, and no guard to
// fight.
//
// FAILS OPEN, ALWAYS. If the engine binary is missing, the pipe doesn't
// exist yet, or the stream stalls, the renderer's own fallback (see
// features/live/audio/tier1.ts) keeps using the raw microphone. Every
// failure path here is a status update, never an exception and never
// silence forwarded as if it were real audio.
import { ipcMain, BrowserWindow, app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import * as net from 'net'

const TIER1_PIPE = '\\\\.\\pipe\\CallRiseAI_Denoised_v1'

// Same unhurried cadence as virtualmic.ts's own restart backoff intent: the
// engine may legitimately not be running (Tier 1 switched off), so retrying
// must cost nothing while idle rather than hammering a pipe that isn't there.
const RETRY_MS = 1_000

export interface Tier1Status {
  /** We found a kern_bridge.exe binary we could launch — the ONLY condition
   *  that should ever gate whether Tier 1 can be turned on anywhere in the
   *  app (tray, settings toggle, spawn gate, off-state copy). Computed the
   *  same way virtualmic.ts's helperAvailable is, and for the identical
   *  reason: BUG-history elsewhere in this codebase (species 21/the
   *  hollow-green taxonomy) is full of "the same boolean, computed six
   *  times, five of them wrong" — this interface exists so there is exactly
   *  one place that can be wrong. */
  engineAvailable: boolean
  /** kern_bridge.exe is currently running as our child process. */
  engineRunning: boolean
  /** The pipe client currently has a live connection to the engine. Can be
   *  true only when engineRunning is also true, but is tracked separately —
   *  the engine can be running and still mid-connect, or the pipe can drop
   *  without the process itself exiting. */
  connected: boolean
  /** Absolute path to the engine binary we resolved, or null (diagnostics). */
  enginePath: string | null
}

let child: ChildProcess | null = null
let socket: net.Socket | null = null
let retryTimer: NodeJS.Timeout | null = null
let wanted = false
let connected = false
let carry: Buffer | null = null

/** Pure, exported for direct unit testing: turns a raw pipe chunk plus
 *  whatever odd trailing byte survived from the LAST chunk into a
 *  16-bit-aligned Float32Array and the new carry to keep for next time.
 *
 *  Why the carry matters: kern_bridge writes 960-byte (480-sample) frames,
 *  but TCP/pipe delivery makes no promise about chunk boundaries lining up
 *  with that — a 'data' event can end mid-sample. Truncating the odd byte
 *  instead of carrying it would silently shift every subsequent sample's
 *  byte pairing by one, which doesn't throw or drop audio — it degrades it
 *  into full-scale noise, the worst possible failure for a feature whose
 *  entire job is cleaning audio. */
export function parsePcmChunk(
  chunk: Buffer,
  priorCarry: Buffer | null
): { floats: Float32Array; nextCarry: Buffer | null } {
  let bytes = chunk
  if (priorCarry && priorCarry.length) {
    bytes = Buffer.concat([priorCarry, chunk])
  }
  const usable = bytes.length - (bytes.length % 2)
  const nextCarry = usable < bytes.length ? bytes.subarray(usable) : null
  if (usable <= 0) return { floats: new Float32Array(0), nextCarry }

  const sampleCount = usable / 2
  const floats = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    floats[i] = bytes.readInt16LE(i * 2) / 32768
  }
  return { floats, nextCarry }
}

// Same resolution order as virtualmic.ts's resolveHelperPath: explicit env
// override for dev, then the packaged app's own resources, then a sibling
// dev repo built in place. kern_bridge.exe resolves df.lib's model file
// relative to its own binary location, so (like michelper) it must be run
// from a tree carrying its runtime dependencies alongside it.
function resolveEnginePath(): string | null {
  const candidates = [
    process.env['CALLRISE_KERN_BRIDGE_PATH'],
    join(process.resourcesPath ?? '', 'tier1', 'kern_bridge.exe'),
    join(app.getAppPath(), '..', 'kern-bridge', 'kern_bridge.exe')
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

export function getStatus(): Tier1Status {
  const enginePath = resolveEnginePath()
  return {
    engineAvailable: enginePath !== null,
    engineRunning: child !== null,
    connected,
    enginePath
  }
}

function broadcast(): void {
  const status = getStatus()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('tier1:status', status)
  }
}

function setConnected(value: boolean): void {
  if (connected === value) return
  connected = value
  broadcast()
}

function scheduleRetry(): void {
  if (!wanted || retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    connectPipe()
  }, RETRY_MS)
}

function connectPipe(): void {
  if (!wanted || socket) return
  const sock = net.createConnection(TIER1_PIPE)
  socket = sock
  carry = null

  sock.on('connect', () => {
    if (socket !== sock) {
      // A stop() landed between createConnection and this callback.
      try {
        sock.destroy()
      } catch {
        /* already gone */
      }
      return
    }
    setConnected(true)
  })

  sock.on('data', (buf: Buffer) => {
    if (socket !== sock) return
    const { floats, nextCarry } = parsePcmChunk(buf, carry)
    carry = nextCarry
    if (floats.length === 0) return
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('tier1:pcm', floats.buffer)
    }
  })

  // ENOENT (no pipe — engine not running) is the ordinary idle case, not a
  // failure worth distinguishing from any other drop: both mean "keep
  // quietly retrying, keep using raw audio in the meantime."
  const onDrop = (): void => {
    if (socket !== sock) return
    socket = null
    setConnected(false)
    scheduleRetry()
  }
  sock.on('error', onDrop)
  sock.on('close', onDrop)
}

function disconnectPipe(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  if (socket) {
    try {
      socket.destroy()
    } catch {
      /* already gone */
    }
    socket = null
  }
  setConnected(false)
}

/** Starts kern_bridge.exe against the given real-mic friendly name (never a
 *  virtual/third-party device — see the F-08 exclusion in devices.ts's
 *  auto-pick path) and begins the pipe client. A no-op, not an error, if
 *  Tier 1 is already running: the caller (the renderer toggle) doesn't need
 *  to know whether this is the first start of the session. */
export function start(micName: string): { ok: boolean; error?: string } {
  if (child) return { ok: true }
  const enginePath = resolveEnginePath()
  if (!enginePath) return { ok: false, error: 'noise-cancellation engine not found' }

  try {
    child = spawn(enginePath, [micName], { stdio: 'ignore' })
  } catch (err) {
    child = null
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  child.on('exit', () => {
    child = null
    disconnectPipe()
    // Explicit, not relied-on-implicitly: disconnectPipe() destroys the
    // socket, and a real net.Socket eventually emits its own 'close' after
    // destroy() — which would ALSO reach scheduleRetry() via onDrop — but
    // that is Node's async internals, not something this module controls or
    // should depend on to keep retrying. Scheduling it here directly means
    // the retry loop's liveness never depends on exactly how or when a
    // destroyed socket gets around to firing its own teardown event.
    //
    // A user-initiated stop() already set wanted=false before killing the
    // child, so this is a no-op in that case (scheduleRetry checks wanted).
    // An unexpected exit leaves wanted true, so this keeps quietly retrying
    // a pipe whose owning process is gone — harmless (ENOENT forever) and
    // exactly the fail-open behaviour this module promises.
    scheduleRetry()
    broadcast()
  })

  wanted = true
  connectPipe()
  broadcast()
  return { ok: true }
}

export function stop(): void {
  wanted = false
  disconnectPipe()
  if (child) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    child = null
  }
  broadcast()
}

export function registerTier1(): void {
  ipcMain.handle('tier1:getStatus', () => getStatus())
  ipcMain.handle('tier1:start', (_e, micName: unknown) =>
    typeof micName === 'string' && micName.length > 0
      ? start(micName)
      : { ok: false, error: 'no microphone name given' }
  )
  ipcMain.handle('tier1:stop', () => {
    stop()
    return { ok: true }
  })
}

/** Test/shutdown seam — mirrors virtualmic.ts's disposeVirtualMic(), called
 *  from index.ts's before-quit handler so a live engine child is never left
 *  orphaned when the app exits. */
export function disposeTier1(): void {
  stop()
}
