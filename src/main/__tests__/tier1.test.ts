// M27 — Tier 1's pipe client, driven the way production drives it: real
// exported start()/stop()/getStatus(), a fake net.Socket the test controls
// by emitting the same events the real 'net' module would, and a fake
// ChildProcess for the spawned engine.
//
// FAILS OPEN is the property every test here is really checking: whatever
// goes wrong (no binary, dropped pipe, malformed final byte), the module
// must degrade to "not connected" and keep retrying quietly — never throw,
// never report a connection that isn't real.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sentToWindows: { channel: string; payload: unknown }[] = []
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: unknown) => sentToWindows.push({ channel, payload }) }
}

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: { getAllWindows: () => [fakeWindow] },
  app: { getAppPath: () => '/app' }
}))

let engineExists = true
/** Every path resolveEnginePath() probed, in order — so a test can assert
 *  WHICH locations are searched, not merely that something was found. */
const probedPaths: string[] = []
/** Stands in for %LOCALAPPDATA%\CallRiseAI\kern_bridge_status.json. null =
 *  the file does not exist (readFileSync throws, exactly as the real one
 *  does); a string is its raw contents, valid JSON or otherwise. */
let statusFileContents: string | null = null
const statusReadPaths: string[] = []
vi.mock('fs', () => ({
  existsSync: (p: string) => {
    probedPaths.push(p)
    return engineExists
  },
  readFileSync: (p: string) => {
    statusReadPaths.push(String(p))
    if (statusFileContents === null) {
      const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return statusFileContents
  }
}))

class FakeSocket extends EventEmitter {
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}
let lastSocket: FakeSocket | null = null
let connectionAttempts = 0
vi.mock('net', () => ({
  createConnection: () => {
    connectionAttempts++
    lastSocket = new FakeSocket()
    return lastSocket
  }
}))

class FakeChild extends EventEmitter {
  killed = false
  // The status file is matched against this — see resolveDenoisingActive().
  pid = 4242
  kill(): void {
    this.killed = true
    this.emit('exit')
  }
}
let lastChild: FakeChild | null = null
let spawnShouldThrow = false
vi.mock('child_process', () => ({
  spawn: () => {
    if (spawnShouldThrow) throw new Error('spawn failed')
    lastChild = new FakeChild()
    return lastChild
  }
}))

const { start, stop, getStatus, registerTier1, parsePcmChunk, readEngineStatus } =
  await import('../tier1')

/** A well-formed status file for the pid FakeChild reports. */
function statusJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 4242,
    modelLoaded: true,
    mic: 'USB Microphone',
    modelPath: 'C:\\ProgramData\\CallRiseAI\\Models\\DeepFilterNet3_onnx.tar.gz',
    ...over
  })
}

/** 16-bit signed PCM for a value in [-1, 1], little-endian — the exact byte
 *  shape kern_bridge writes and this module has to decode correctly. */
function pcm16(...values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2)
  values.forEach((v, i) => buf.writeInt16LE(Math.round(v * 32767), i * 2))
  return buf
}

beforeEach(() => {
  engineExists = true
  spawnShouldThrow = false
  connectionAttempts = 0
  lastSocket = null
  lastChild = null
  sentToWindows.length = 0
  probedPaths.length = 0
  statusFileContents = null
  statusReadPaths.length = 0
  handlers.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  stop()
  vi.useRealTimers()
})

describe('parsePcmChunk — the byte-carry logic in isolation', () => {
  it('decodes a clean, evenly-sized chunk with no carry needed', () => {
    const { floats, nextCarry } = parsePcmChunk(pcm16(0.5, -0.5), null)
    expect(nextCarry).toBeNull()
    expect(floats.length).toBe(2)
    expect(floats[0]).toBeCloseTo(0.5, 3)
    expect(floats[1]).toBeCloseTo(-0.5, 3)
  })

  it('carries an odd trailing byte forward instead of desyncing the stream', () => {
    const whole = pcm16(0.25, -0.25, 0.75)
    // Split mid-sample: 5 bytes then 1 byte, exactly where a real 'data'
    // event boundary could land.
    const first = whole.subarray(0, 5)
    const second = whole.subarray(5)

    const a = parsePcmChunk(first, null)
    expect(a.floats.length).toBe(2) // two whole samples decoded
    expect(a.nextCarry).not.toBeNull()
    expect(a.nextCarry!.length).toBe(1)

    const b = parsePcmChunk(second, a.nextCarry)
    // RED without the carry: the third sample's low byte would be read
    // against the WRONG high byte, decoding to a different value entirely —
    // not a crash, just quietly wrong audio.
    expect(b.nextCarry).toBeNull()
    expect(b.floats.length).toBe(1)
    expect(b.floats[0]).toBeCloseTo(0.75, 3)
  })

  it('produces zero floats (not a crash) on a single stray byte with no carry', () => {
    const { floats, nextCarry } = parsePcmChunk(Buffer.from([0x42]), null)
    expect(floats.length).toBe(0)
    expect(nextCarry).not.toBeNull()
    expect(nextCarry!.length).toBe(1)
  })
})

describe('engineAvailable is the ONLY gate, and it is engine-binary-exists', () => {
  it('is true when the binary resolves, independent of running/connected state', () => {
    engineExists = true
    expect(getStatus().engineAvailable).toBe(true)
    expect(getStatus().engineRunning).toBe(false)
    expect(getStatus().connected).toBe(false)
  })

  it('is false, and start() refuses, when no binary is found', () => {
    engineExists = false
    const result = start('Realtek Mic')
    expect(result.ok).toBe(false)
    expect(getStatus().engineAvailable).toBe(false)
    expect(getStatus().engineRunning).toBe(false)
  })

  // THE PACKAGED PATH IS LOAD-BEARING AND WAS INITIALLY WRONG. The first
  // version of this module looked in <resources>/tier1/ — a plausible-
  // sounding guess that resolves to nothing in a real packaged build, so
  // engineAvailable would have been false for every shipped user while
  // being true in dev. A silent total failure of the whole feature, with a
  // green suite.
  //
  // The real convention (established by the driver workspace's own
  // _bundle_kern_bridge.ps1, which documents having got this wrong once
  // already) is <resources>/virtualmic-win/ — a SIBLING of app.asar via
  // electron-builder's extraResources, because Node cannot spawn an .exe
  // that only exists inside a packed asar.
  it('probes the packaged extraResources location, not a guessed one', () => {
    engineExists = false // force it to walk every candidate
    getStatus()
    const packaged = probedPaths.find((p) => p.includes('virtualmic-win'))
    expect(packaged).toBeDefined()
    expect(packaged).toContain('kern_bridge.exe')
    // Guards the specific wrong guess from coming back.
    expect(probedPaths.some((p) => /[/\\]tier1[/\\]/.test(p))).toBe(false)
  })

  it('honours the env override ahead of every other candidate', () => {
    engineExists = false
    process.env['CALLRISE_KERN_BRIDGE_PATH'] = 'C:/custom/kern_bridge.exe'
    try {
      getStatus()
      expect(probedPaths[0]).toBe('C:/custom/kern_bridge.exe')
    } finally {
      delete process.env['CALLRISE_KERN_BRIDGE_PATH']
    }
  })
})

describe('start() / stop() lifecycle', () => {
  it('spawns the engine with the given mic name and connects the pipe', () => {
    const result = start('USB Microphone')
    expect(result.ok).toBe(true)
    expect(getStatus().engineRunning).toBe(true)
    expect(connectionAttempts).toBe(1)

    lastSocket!.emit('connect')
    expect(getStatus().connected).toBe(true)
  })

  it('is a no-op (not an error) when already running', () => {
    start('Mic A')
    const sock1 = lastSocket
    const child1 = lastChild
    const result = start('Mic B') // caller doesn't need to know it's already on
    expect(result.ok).toBe(true)
    expect(lastSocket).toBe(sock1) // no second connection attempt
    expect(lastChild).toBe(child1) // no second spawn
  })

  it('stop() kills the engine and disconnects the pipe', () => {
    start('Mic A')
    lastSocket!.emit('connect')
    expect(getStatus().connected).toBe(true)

    stop()
    expect(getStatus().engineRunning).toBe(false)
    expect(getStatus().connected).toBe(false)
    expect(lastChild!.killed).toBe(true)
  })

  it('a spawn failure fails open — reports not-running rather than throwing', () => {
    spawnShouldThrow = true
    expect(() => start('Mic A')).not.toThrow()
    expect(getStatus().engineRunning).toBe(false)
  })
})

describe('fail-open: a dropped pipe keeps retrying quietly, never throws', () => {
  it('a pipe error clears connected and schedules a retry', () => {
    start('Mic A')
    lastSocket!.emit('connect')
    expect(getStatus().connected).toBe(true)

    lastSocket!.emit('error', new Error('ENOENT'))
    expect(getStatus().connected).toBe(false)

    // The retry is genuinely scheduled, not abandoned — advancing the fake
    // clock past RETRY_MS must produce a new connection attempt.
    expect(connectionAttempts).toBe(1)
    vi.advanceTimersByTime(1_001)
    expect(connectionAttempts).toBe(2)
  })

  it('an unexpected engine exit tears the pipe down and still keeps retrying', () => {
    start('Mic A')
    lastSocket!.emit('connect')
    lastChild!.emit('exit') // the child died on its own, not via stop()

    expect(getStatus().engineRunning).toBe(false)
    expect(getStatus().connected).toBe(false)
    // wanted stays true (only stop() clears it) — an unexpected death still
    // retries the pipe, harmlessly, exactly like the engine being off.
    vi.advanceTimersByTime(1_001)
    expect(connectionAttempts).toBeGreaterThanOrEqual(2)
  })

  it('stop() cancels a pending retry so it cannot reconnect after being told to stop', () => {
    start('Mic A')
    lastSocket!.emit('error', new Error('ENOENT')) // schedules a retry
    stop()
    vi.advanceTimersByTime(5_000)
    // RED without the cancel: a queued retry firing after stop() would
    // silently resurrect a connection the user explicitly turned off.
    expect(getStatus().connected).toBe(false)
    expect(getStatus().engineRunning).toBe(false)
  })
})

describe('data received while not the current socket is ignored', () => {
  it('a stale socket emitting data after a stop() cannot leak audio through', () => {
    start('Mic A')
    const staleSocket = lastSocket!
    stop()
    staleSocket.emit('data', pcm16(1, 1, 1))
    // Nothing should have been forwarded to any window — the socket is no
    // longer the active one by the time this fires.
    expect(sentToWindows.filter((m) => m.channel === 'tier1:pcm')).toHaveLength(0)
  })
})

// THE PASSTHROUGH HOLE. kern_bridge loads DeepFilterNet3 from a compiled-in
// absolute path and, if that file is absent, logs a warning and runs anyway —
// pushing captured audio through UNCHANGED. From the client's side that is
// indistinguishable from success: the pipe connects, full-rate audio flows,
// every other status field reads healthy. The user is told their microphone is
// being cleaned while it is not, and is worse off than doing nothing, because
// this path bypasses Chromium's echo cancellation to deliver raw audio.
//
// denoisingActive is the only field that closes it, and it must be pessimistic
// in every uncertain case.
describe('denoisingActive — passthrough must be visible, never assumed away', () => {
  it('is true only when the engine reports its model loaded, for THIS pid', () => {
    statusFileContents = statusJson({ modelLoaded: true })
    start('USB Microphone')
    expect(getStatus().denoisingActive).toBe(true)
  })

  it('is FALSE when the engine reports passthrough, while connected stays true', () => {
    statusFileContents = statusJson({ modelLoaded: false })
    start('USB Microphone')
    lastSocket!.emit('connect')
    // The whole point: a healthy-looking connection that is not denoising.
    expect(getStatus().connected).toBe(true)
    expect(getStatus().denoisingActive).toBe(false)
  })

  it('is null when the engine is not running at all', () => {
    statusFileContents = statusJson({ modelLoaded: true })
    // RED without the child check: a leftover status file would let a stopped
    // engine report active denoising.
    expect(getStatus().engineRunning).toBe(false)
    expect(getStatus().denoisingActive).toBeNull()
  })

  // STALENESS IS THE SUBTLE ONE. The status file outlives the process that
  // wrote it. A run that loaded its model leaves modelLoaded:true on disk; if
  // the model is then deleted and the engine restarts into passthrough, a read
  // without the pid check returns the OLD run's true — the exact hollow-green
  // this field exists to close, merely relocated onto disk.
  it('ignores a status file left behind by a DIFFERENT engine run', () => {
    statusFileContents = statusJson({ pid: 999, modelLoaded: true })
    start('USB Microphone')
    expect(lastChild!.pid).toBe(4242)
    expect(getStatus().denoisingActive).toBeNull()
  })

  it('is null when no status file exists — an older engine build', () => {
    statusFileContents = null
    start('USB Microphone')
    expect(getStatus().denoisingActive).toBeNull()
  })

  it('is null on malformed JSON rather than throwing out of getStatus()', () => {
    statusFileContents = '{"pid": 4242, "modelLoa'
    start('USB Microphone')
    expect(() => getStatus()).not.toThrow()
    expect(getStatus().denoisingActive).toBeNull()
  })

  // A half-written file can parse yet be missing the one field that matters.
  // Absence must read as unknown, never as false: false is a claim ABOUT the
  // engine, null is the absence of one, and only one of those is honest here.
  it('is null when modelLoaded is absent or not a boolean', () => {
    start('USB Microphone')
    statusFileContents = JSON.stringify({ pid: 4242, mic: 'x' })
    expect(getStatus().denoisingActive).toBeNull()
    statusFileContents = JSON.stringify({ pid: 4242, modelLoaded: 'true' })
    expect(getStatus().denoisingActive).toBeNull()
  })

  it('reads from %LOCALAPPDATA%\\CallRiseAI, where the engine actually writes', () => {
    process.env['LOCALAPPDATA'] = 'C:\\Users\\Someone\\AppData\\Local'
    statusFileContents = statusJson()
    start('USB Microphone')
    getStatus()
    const p = statusReadPaths[0]
    expect(p).toContain('CallRiseAI')
    expect(p).toContain('kern_bridge_status.json')
  })

  it('re-checks after connect, so a status file that lands late is still seen', () => {
    statusFileContents = null // engine has not written it yet
    start('USB Microphone')
    lastSocket!.emit('connect')
    expect(getStatus().denoisingActive).toBeNull()

    // The engine finishes starting up and writes its file.
    statusFileContents = statusJson({ modelLoaded: true })
    vi.advanceTimersByTime(500)

    // RED without the re-check: the renderer would hold that first null for
    // the entire session and permanently refuse a perfectly healthy engine —
    // a fallback so conservative it disables the feature it protects.
    expect(getStatus().denoisingActive).toBe(true)
    const broadcasts = sentToWindows.filter((m) => m.channel === 'tier1:status')
    expect(broadcasts.some((m) => (m.payload as { denoisingActive: unknown }).denoisingActive === true)).toBe(true)
  })

  it('stops re-checking instead of polling forever when no file ever appears', () => {
    statusFileContents = null
    start('USB Microphone')
    lastSocket!.emit('connect')
    vi.advanceTimersByTime(60_000)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1) // only the pipe retry, if any
    expect(getStatus().denoisingActive).toBeNull()
  })
})

describe('readEngineStatus parses the engine sidecar directly', () => {
  it('returns every field for a well-formed file', () => {
    statusFileContents = statusJson({ modelLoaded: false, mic: 'Realtek' })
    expect(readEngineStatus()).toEqual({
      pid: 4242,
      modelLoaded: false,
      mic: 'Realtek',
      modelPath: 'C:\\ProgramData\\CallRiseAI\\Models\\DeepFilterNet3_onnx.tar.gz'
    })
  })

  it('returns null when pid is missing — the file cannot be attributed', () => {
    statusFileContents = JSON.stringify({ modelLoaded: true })
    expect(readEngineStatus()).toBeNull()
  })
})

describe('registerTier1 wires the IPC surface real callers use', () => {
  it('tier1:start refuses a non-string mic name instead of crashing the handler', async () => {
    registerTier1()
    const result = await handlers.get('tier1:start')!({}, 42)
    expect(result).toEqual({ ok: false, error: 'no microphone name given' })
  })

  it('tier1:start with a real name starts the engine', async () => {
    registerTier1()
    const result = await handlers.get('tier1:start')!({}, 'Real Mic')
    expect(result).toEqual({ ok: true })
    expect(getStatus().engineRunning).toBe(true)
  })

  it('tier1:stop stops it', async () => {
    registerTier1()
    await handlers.get('tier1:start')!({}, 'Real Mic')
    const result = await handlers.get('tier1:stop')!({})
    expect(result).toEqual({ ok: true })
    expect(getStatus().engineRunning).toBe(false)
  })
})
