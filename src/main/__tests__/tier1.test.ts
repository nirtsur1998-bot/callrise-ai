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
vi.mock('fs', () => ({ existsSync: () => engineExists }))

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

const { start, stop, getStatus, registerTier1, parsePcmChunk } = await import('../tier1')

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
