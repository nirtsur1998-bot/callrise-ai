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
import { existsSync, readFileSync } from 'fs'
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
   *  without the process itself exiting.
   *
   *  DOES NOT MEAN "audio is being denoised". kern_bridge loads its model
   *  from a compiled-in absolute path
   *  (C:\ProgramData\CallRiseAI\Models\DeepFilterNet3_onnx.tar.gz) and, if
   *  df_create fails because that file is absent, logs a warning and runs in
   *  PASSTHROUGH — pushing the captured audio through unchanged rather than
   *  refusing to start. From this module's side that is indistinguishable
   *  from working: the pipe connects, full-rate audio flows, every status
   *  field reads healthy, and the user's audio is simply not being cleaned.
   *
   *  That is a genuine hollow-green shape, and it is closed by
   *  `denoisingActive` below, NOT by this field. Never read
   *  `connected: true` as proof of denoising. */
  connected: boolean
  /**
   * Whether the engine actually loaded its denoising model — the ONLY field
   * that means "audio coming through the pipe is being cleaned".
   *
   *  true  — model loaded; the pipe carries genuinely denoised audio.
   *  false — the engine is in PASSTHROUGH (model missing or df_create
   *          failed). The pipe carries real, unprocessed audio, which makes
   *          it strictly WORSE than the raw microphone: raw at least gets
   *          Chromium's echo cancellation and gain control, and this path
   *          bypasses both. A false here is a real error state, not a
   *          degraded-but-fine one.
   *  null  — unknown: the engine has not written its status yet, or it is an
   *          older build with no status file. Treated identically to false
   *          by every consumer. An unverifiable claim of denoising is
   *          precisely what this field exists to stop the app from making.
   */
  denoisingActive: boolean | null
  /** Absolute path to the engine binary we resolved, or null (diagnostics). */
  enginePath: string | null
}

/**
 * What kern_bridge.exe writes once at startup, before its audio loop begins.
 *
 * WHY A FILE AND NOT THE PIPE PROTOCOL. The pipe's own contract (documented
 * in kern_bridge.cpp) is that the push path must never block, stall or fail;
 * prefixing a header or interleaving control frames puts new parsing on the
 * hot path for one boolean that never changes after startup. A second pipe
 * would mean a second overlapped-IO server in the engine for that same
 * boolean. A file written once, before any audio moves, touches the audio
 * path zero times and keeps the PCM stream byte-for-byte backward compatible
 * with engines that predate it.
 */
interface EngineStatusFile {
  pid: number
  modelLoaded: boolean
  mic: string
  modelPath: string
}

function statusFilePath(): string {
  // The %LOCALAPPDATA%\CallRiseAI root the engine's own logs already use.
  return join(process.env['LOCALAPPDATA'] ?? '', 'CallRiseAI', 'kern_bridge_status.json')
}

/**
 * Reads the engine's self-reported denoise state, or null when it cannot be
 * established: no file, unreadable file, malformed JSON, or a `modelLoaded`
 * that is not actually a boolean.
 *
 * Every uncertain case returns null rather than guessing, and callers treat
 * null as "do not prefer the pipe" — so the failure direction is toward the
 * raw microphone, which is the safe one. In particular a partially-written
 * file (engine killed mid-write) must read as unknown, never as false:
 * `false` is a claim about the engine, `null` is the absence of one.
 *
 * Exported for direct testing against fixture files.
 */
export function readEngineStatus(): EngineStatusFile | null {
  try {
    const parsed = JSON.parse(readFileSync(statusFilePath(), 'utf8')) as Partial<EngineStatusFile>
    if (typeof parsed?.modelLoaded !== 'boolean') return null
    if (typeof parsed?.pid !== 'number') return null
    return {
      pid: parsed.pid,
      modelLoaded: parsed.modelLoaded,
      mic: typeof parsed.mic === 'string' ? parsed.mic : '',
      modelPath: typeof parsed.modelPath === 'string' ? parsed.modelPath : ''
    }
  } catch {
    return null
  }
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

// The packaged location is `<resources>\virtualmic-win\kern_bridge.exe` — a
// SIBLING of app.asar, not inside it. That is electron-builder's
// extraResources mechanism, and it is load-bearing rather than stylistic:
// Node cannot spawn an .exe that only exists inside a packed asar
// (existsSync returns false for it), so a bundle packed into the archive
// resolves to "engine not found" every single time even though the file is
// genuinely present. The existing _bundle_kern_bridge.ps1 in the driver
// workspace stages exactly this layout and documents that same root cause
// from when it was got wrong before — this path matches it deliberately.
//
// NOT the model's location. kern_bridge compiles in an absolute
// DF_MODEL_PATH of C:\ProgramData\CallRiseAI\Models\DeepFilterNet3_onnx.tar.gz
// and does not look beside its own binary for it (unlike macOS's michelper,
// which does). See the passthrough note on Tier1Status.connected for why
// that distinction has a user-visible consequence.
function resolveEnginePath(): string | null {
  const candidates = [
    process.env['CALLRISE_KERN_BRIDGE_PATH'],
    // Packaged: staged next to app.asar by the bundling script.
    join(process.resourcesPath ?? '', 'virtualmic-win', 'kern_bridge.exe'),
    // Dev: the driver workspace's own staging tree, a sibling checkout of
    // this repo.
    join(app.getAppPath(), '..', 'CALLRISE AI', '_virtualmic_win_stage', 'kern_bridge.exe')
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Resolves denoisingActive for the CURRENTLY running engine.
 *
 * The pid check is the whole point of this function and not a formality. The
 * status file outlives the process that wrote it, so a run that loaded its
 * model successfully leaves behind `modelLoaded: true` on disk; if the model
 * is then deleted and the engine restarted into passthrough, a naive read
 * returns the OLD run's `true` and the app confidently reports denoising that
 * has stopped happening — the same hollow-green shape this field was added to
 * close, merely relocated. Matching the file's pid against our own child's is
 * what makes the answer about this engine rather than some engine.
 */
function resolveDenoisingActive(): boolean | null {
  if (!child?.pid) return null // nothing running: nothing to claim
  const status = readEngineStatus()
  if (!status) return null // no file, or unreadable/malformed: unknown
  if (status.pid !== child.pid) return null // some other run's file: unknown
  return status.modelLoaded
}

export function getStatus(): Tier1Status {
  const enginePath = resolveEnginePath()
  return {
    engineAvailable: enginePath !== null,
    engineRunning: child !== null,
    connected,
    denoisingActive: resolveDenoisingActive(),
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

// Bounded, and deliberately so. If the status file hasn't appeared within
// this many polls the answer really is "this engine does not report" — an
// older build, or a locked-down %LOCALAPPDATA% — and null is the correct,
// permanent answer for it. An unbounded poll would instead keep a timer alive
// for the life of the app to keep re-asking a question already answered.
const STATUS_RECHECK_MS = 400
const STATUS_RECHECK_MAX = 10
let statusRecheckTimer: NodeJS.Timeout | null = null
let statusRechecksLeft = 0

function scheduleStatusRecheck(): void {
  if (statusRecheckTimer) return
  statusRechecksLeft = STATUS_RECHECK_MAX
  const tick = (): void => {
    statusRecheckTimer = null
    if (!wanted || !child) return
    if (resolveDenoisingActive() !== null) {
      broadcast() // the answer arrived — publish it and stop asking
      return
    }
    if (--statusRechecksLeft <= 0) return
    statusRecheckTimer = setTimeout(tick, STATUS_RECHECK_MS)
  }
  statusRecheckTimer = setTimeout(tick, STATUS_RECHECK_MS)
}

function cancelStatusRecheck(): void {
  if (statusRecheckTimer) {
    clearTimeout(statusRecheckTimer)
    statusRecheckTimer = null
  }
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
    // The engine writes its status file during startup, which can land after
    // this connect fires — so the broadcast above may carry
    // denoisingActive: null purely because we asked too early. Without this
    // re-check the renderer would sit on that null for the whole session and
    // permanently refuse the pipe on a perfectly healthy engine: a fallback
    // so conservative it disables the feature it was protecting.
    scheduleStatusRecheck()
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
  cancelStatusRecheck()
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
export function start(micName: string, attenDb?: number): { ok: boolean; error?: string } {
  if (child) return { ok: true }
  const enginePath = resolveEnginePath()
  if (!enginePath) return { ok: false, error: 'noise-cancellation engine not found' }

  // Denoise strength. `--atten <db>` is omitted entirely when the caller
  // doesn't send a number ("high") — the engine's compiled-in 100dB default
  // ("no mix-back of the noisy signal") stays the single source of truth
  // rather than being restated here where it could drift. kern_bridge
  // validates and clamps the value itself, so this only guards the type:
  // shipping NaN as an argv string would trip the engine's "not a number"
  // path and silently run at default, which is a claim ("medium") the audio
  // wouldn't honour.
  const args = [micName]
  if (typeof attenDb === 'number' && Number.isFinite(attenDb)) {
    args.push('--atten', String(attenDb))
  }

  try {
    child = spawn(enginePath, args, { stdio: 'ignore' })
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
  ipcMain.handle('tier1:start', (_e, micName: unknown, attenDb: unknown) =>
    typeof micName === 'string' && micName.length > 0
      ? start(micName, typeof attenDb === 'number' ? attenDb : undefined)
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
