// A local stand-in for Deepgram's streaming endpoint, built for one purpose:
// to enforce the constraint that makes the 90-second lag bug possible.
//
// Deepgram ingests audio at a maximum of ~1.25x realtime. That single number is
// the whole reason lag is a RATCHET rather than a spike: a producer running at
// 1.0x can only claw back 0.25x per second, so 90 seconds of backlog needs six
// flawless minutes to clear, and any further hiccup resets the clock. A mock
// that acknowledged instantly would make every regression test pass while
// proving nothing.
//
// It also models the two failure modes that matter, which are NOT the same:
//
//   drop()      — a clean close. The client sees 'close' and reconnects. This
//                 is what an offline toggle produces, and it exercises the
//                 discard path rather than the buffering path.
//   blackhole() — stop reading the socket without closing it. The kernel
//                 receive buffer fills, TCP advertises a zero window, the
//                 sender's buffer backs up, and `readyState` stays OPEN the
//                 whole time. This is the real bug: a Wi-Fi drop with no FIN.

import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'

/** Deepgram's documented streaming ingest ceiling, as a multiple of realtime. */
export const INGEST_RATE = 1.25

export interface MockDeepgramOptions {
  /** Multiple of realtime the server will acknowledge audio at. */
  ingestRate?: number
  /** How often a Results message is emitted. */
  emitMs?: number
}

interface Connection {
  socket: WebSocket
  sampleRate: number
  channels: number
  /** Seconds of audio actually received on this connection. */
  receivedSec: number
  /** Seconds acknowledged so far — capped by the ingest rate. */
  processedSec: number
  lastTickMs: number
  timer: ReturnType<typeof setInterval> | null
  paused: boolean
}

export class MockDeepgram {
  private readonly server: WebSocketServer
  private readonly ingestRate: number
  private readonly emitMs: number
  private connections: Connection[] = []
  /** Every connection ever opened — lets a test count reconnects. */
  connectionCount = 0

  private constructor(server: WebSocketServer, options: MockDeepgramOptions) {
    this.server = server
    this.ingestRate = options.ingestRate ?? INGEST_RATE
    this.emitMs = options.emitMs ?? 100
    this.server.on('connection', (socket, request) => {
      this.connectionCount++
      const url = new URL(request.url ?? '/', 'ws://localhost')
      const connection: Connection = {
        socket,
        sampleRate: Number(url.searchParams.get('sample_rate')) || 16000,
        channels: Number(url.searchParams.get('channels')) || 1,
        receivedSec: 0,
        processedSec: 0,
        lastTickMs: performance.now(),
        timer: null,
        paused: false
      }
      this.connections.push(connection)

      socket.on('message', (data, isBinary) => {
        if (!isBinary) return // KeepAlive / Finalize / CloseStream are JSON
        const bytes = data as Buffer
        connection.receivedSec += bytes.byteLength / 2 / connection.channels / connection.sampleRate
      })
      socket.on('close', () => {
        if (connection.timer) clearInterval(connection.timer)
        this.connections = this.connections.filter((c) => c !== connection)
      })
      socket.on('error', () => {
        /* the test asserts on client behaviour, not server noise */
      })

      connection.timer = setInterval(() => this.tick(connection), this.emitMs)
    })
  }

  static async start(options: MockDeepgramOptions = {}): Promise<MockDeepgram> {
    const server = new WebSocketServer({ port: 0 })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    return new MockDeepgram(server, options)
  }

  /** `ws://127.0.0.1:<port>` — assign to process.env.DEEPGRAM_LISTEN_URL. */
  get url(): string {
    const { port } = this.server.address() as AddressInfo
    return `ws://127.0.0.1:${port}`
  }

  /**
   * Advance the acknowledgement cursor, never faster than `ingestRate` x the
   * wall time that has actually elapsed. This is the constraint the whole
   * regression suite hangs on.
   */
  private tick(connection: Connection): void {
    const now = performance.now()
    const elapsedSec = (now - connection.lastTickMs) / 1000
    connection.lastTickMs = now
    if (connection.paused || connection.socket.readyState !== connection.socket.OPEN) return

    const budget = elapsedSec * this.ingestRate
    const next = Math.min(connection.receivedSec, connection.processedSec + budget)
    if (next <= connection.processedSec) return

    const start = connection.processedSec
    const duration = next - start
    connection.processedSec = next
    const payload = {
      type: 'Results',
      channel_index: [0, connection.channels],
      channel: {
        alternatives: [
          {
            transcript: 'mock',
            words: [{ word: 'mock', punctuated_word: 'mock', speaker: 0 }]
          }
        ]
      },
      start,
      duration,
      is_final: true,
      speech_final: true
    }
    try {
      connection.socket.send(JSON.stringify(payload))
    } catch {
      /* closing */
    }
  }

  /**
   * M37 / BUG-D — the Metadata frame real Deepgram sends on every connection,
   * carrying the channel count THE SERVER received and its own request id.
   * Explicit rather than automatic so existing tests see exactly the traffic
   * they always did.
   */
  sendMetadata(channels: number, requestId: string): void {
    const c = this.connections.at(-1)
    if (!c) throw new Error('no connection to send Metadata on')
    c.socket.send(JSON.stringify({ type: 'Metadata', channels, request_id: requestId }))
  }

  /** The channel count the CLIENT asked for on the newest connection, read
   *  from its query string — so a test can assert ask-versus-got. */
  get requestedChannels(): number {
    return this.connections.at(-1)?.channels ?? 0
  }

  /** Seconds acknowledged on the newest connection — the client's Y cursor. */
  get acknowledgedSec(): number {
    return this.connections.at(-1)?.processedSec ?? 0
  }

  /** Seconds actually received on the newest connection. */
  get receivedSec(): number {
    return this.connections.at(-1)?.receivedSec ?? 0
  }

  /** Total seconds received across every connection this session. */
  get totalReceivedSec(): number {
    return this.connections.reduce((sum, c) => sum + c.receivedSec, 0)
  }

  /** A clean close: the client sees 'close' and reconnects. */
  drop(): void {
    for (const c of this.connections) {
      try {
        c.socket.terminate()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Stop reading without closing — the half-open case. `readyState` stays OPEN
   * on the client while nothing gets through, which is exactly why
   * `readyState === OPEN` is not a liveness check.
   */
  blackhole(): void {
    for (const c of this.connections) {
      c.paused = true
      // Reaching for the underlying socket on purpose: pausing it is what makes
      // the kernel stop draining, which is the mechanism under test.
      const raw = (c.socket as unknown as { _socket?: { pause(): void } })._socket
      raw?.pause()
    }
  }

  /** Undo `blackhole()`. */
  restore(): void {
    for (const c of this.connections) {
      c.paused = false
      c.lastTickMs = performance.now() // don't hand back a giant catch-up budget
      const raw = (c.socket as unknown as { _socket?: { resume(): void } })._socket
      raw?.resume()
    }
  }

  async stop(): Promise<void> {
    for (const c of this.connections) {
      if (c.timer) clearInterval(c.timer)
      try {
        c.socket.terminate()
      } catch {
        /* ignore */
      }
    }
    this.connections = []
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
