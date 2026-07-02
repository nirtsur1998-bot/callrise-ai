import { ipcMain, BrowserWindow, systemPreferences, shell } from 'electron'
import WebSocket from 'ws'

const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen'
const MAX_CHUNK_BYTES = 1 << 16 // 64 KB safety cap on a single audio frame
const CONNECT_TIMEOUT_MS = 8000 // give up if we never reach 'open'
const STABLE_AFTER_MS = 4000 // connection considered healthy after this long
const STOP_FLUSH_MS = 1500 // wait this long for final words on stop
const KEEPALIVE_MS = 5000
const MAX_RECONNECTS = 3

interface StartOptions {
  sampleRate: number
}

// Everything about one live session lives here, so restarts/reconnects can't
// cross-contaminate (stale timers, stale counters, stale sockets).
interface Session {
  window: BrowserWindow
  apiKey: string
  sampleRate: number
  ws: WebSocket | null
  keepAlive: ReturnType<typeof setInterval> | null
  connectTimer: ReturnType<typeof setTimeout> | null
  stableTimer: ReturnType<typeof setTimeout> | null
  audioSecondsSent: number
  reconnectAttempts: number
  stopping: boolean
}

let session: Session | null = null

function emit(s: Session, channel: string, payload: unknown): void {
  if (!s.window.isDestroyed()) {
    s.window.webContents.send(channel, payload)
  }
}

function buildUrl(sampleRate: number): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en-US',
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1',
    interim_results: 'true', // word-by-word partial results
    smart_format: 'true',
    punctuate: 'true',
    utterance_end_ms: '1000',
    vad_events: 'true'
  })
  return `${DEEPGRAM_LISTEN_URL}?${params.toString()}`
}

function clearTimers(s: Session): void {
  if (s.keepAlive) {
    clearInterval(s.keepAlive)
    s.keepAlive = null
  }
  if (s.connectTimer) {
    clearTimeout(s.connectTimer)
    s.connectTimer = null
  }
  if (s.stableTimer) {
    clearTimeout(s.stableTimer)
    s.stableTimer = null
  }
}

function teardown(s: Session): void {
  clearTimers(s)
  if (s.ws) {
    try {
      s.ws.removeAllListeners()
      s.ws.terminate()
    } catch {
      /* ignore */
    }
    s.ws = null
  }
}

function failSession(s: Session, message: string): void {
  if (session !== s) return
  teardown(s)
  emit(s, 'transcription:error', { message })
  emit(s, 'transcription:state', { state: 'error' })
  session = null
}

function connect(s: Session): void {
  const ws = new WebSocket(buildUrl(s.sampleRate), {
    headers: { Authorization: `Token ${s.apiKey}` }
  })
  s.ws = ws

  // Watchdog: if we never reach 'open', don't hang in "connecting" forever.
  s.connectTimer = setTimeout(() => {
    if (session === s && ws.readyState !== WebSocket.OPEN) {
      failSession(s, 'Could not reach the transcription service. Check your internet and try again.')
    }
  }, CONNECT_TIMEOUT_MS)

  ws.on('open', () => {
    if (session !== s) {
      ws.close()
      return
    }
    if (s.connectTimer) {
      clearTimeout(s.connectTimer)
      s.connectTimer = null
    }
    // Deepgram restarts its audio clock per connection — align our counter so
    // the latency math stays correct across reconnects.
    s.audioSecondsSent = 0
    emit(s, 'transcription:state', { state: 'listening' })
    // Only forgive the retry budget once the connection has proven stable.
    s.stableTimer = setTimeout(() => {
      s.reconnectAttempts = 0
    }, STABLE_AFTER_MS)
    s.keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }))
      }
    }, KEEPALIVE_MS)
  })

  ws.on('message', (raw: WebSocket.RawData) => {
    if (session !== s) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>
    } catch {
      return
    }
    if (msg.type === 'Results') {
      const channel = msg.channel as
        | { alternatives?: Array<{ transcript?: string }> }
        | undefined
      const transcript = channel?.alternatives?.[0]?.transcript ?? ''
      const start = typeof msg.start === 'number' ? msg.start : 0
      const duration = typeof msg.duration === 'number' ? msg.duration : 0
      // Real-time lag = how far behind live audio this transcript is.
      const lagMs = Math.max(0, (s.audioSecondsSent - (start + duration)) * 1000)
      emit(s, 'transcription:transcript', {
        transcript,
        isFinal: msg.is_final === true,
        speechFinal: msg.speech_final === true,
        lagMs
      })
    } else if (msg.type === 'UtteranceEnd') {
      emit(s, 'transcription:utteranceEnd', {})
    }
  })

  ws.on('unexpected-response', (_req, res) => {
    const message =
      res.statusCode === 401
        ? 'Your Deepgram API key was rejected. Check DEEPGRAM_API_KEY in your .env file.'
        : `Couldn't connect to Deepgram (HTTP ${res.statusCode ?? 'unknown'}).`
    try {
      res.destroy()
    } catch {
      /* ignore */
    }
    failSession(s, message)
  })

  ws.on('error', (err: Error) => {
    // 'close' (or the watchdog) decides the user-facing outcome; just log here.
    console.error('[transcription] socket error:', err.message)
  })

  ws.on('close', () => {
    if (session !== s) return
    if (s.keepAlive) {
      clearInterval(s.keepAlive)
      s.keepAlive = null
    }
    if (s.stableTimer) {
      clearTimeout(s.stableTimer)
      s.stableTimer = null
    }
    if (s.stopping) {
      // Graceful stop finished flushing — we're done.
      session = null
      return
    }
    // Unexpected drop — reconnect with exponential backoff.
    if (s.reconnectAttempts < MAX_RECONNECTS) {
      s.reconnectAttempts += 1
      emit(s, 'transcription:state', { state: 'reconnecting', attempt: s.reconnectAttempts })
      const delay = 500 * 2 ** (s.reconnectAttempts - 1)
      setTimeout(() => {
        if (session === s && !s.stopping) connect(s)
      }, delay)
    } else {
      failSession(s, 'Lost connection to the transcription service. Check your internet and try again.')
    }
  })
}

export function disposeTranscription(): void {
  if (session) {
    teardown(session)
    session = null
  }
}

let registered = false

export function registerTranscription(): void {
  if (registered) return
  registered = true

  ipcMain.handle('transcription:start', (event, options: StartOptions) => {
    const key = process.env.DEEPGRAM_API_KEY?.trim() ?? ''
    if (!key) {
      return { ok: false, error: 'no-key' as const }
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) {
      return { ok: false }
    }

    // Replace any previous session entirely.
    disposeTranscription()
    const s: Session = {
      window,
      apiKey: key,
      sampleRate: Number(options?.sampleRate) > 0 ? Number(options.sampleRate) : 16000,
      ws: null,
      keepAlive: null,
      connectTimer: null,
      stableTimer: null,
      audioSecondsSent: 0,
      reconnectAttempts: 0,
      stopping: false
    }
    session = s
    emit(s, 'transcription:state', { state: 'connecting' })
    connect(s)
    return { ok: true as const }
  })

  ipcMain.on('transcription:audio', (event, chunk: ArrayBuffer) => {
    const s = session
    if (!s || !s.ws || s.ws.readyState !== WebSocket.OPEN) return
    // Only the window that owns the session may stream audio.
    if (BrowserWindow.fromWebContents(event.sender) !== s.window) return
    const byteLength =
      chunk instanceof ArrayBuffer
        ? chunk.byteLength
        : ArrayBuffer.isView(chunk)
          ? (chunk as ArrayBufferView).byteLength
          : -1
    if (byteLength <= 0 || byteLength > MAX_CHUNK_BYTES) return
    s.ws.send(chunk)
    // 16-bit PCM => 2 bytes per sample.
    s.audioSecondsSent += byteLength / 2 / s.sampleRate
  })

  ipcMain.handle('transcription:stop', () => {
    const s = session
    if (!s) return { ok: true as const }
    s.stopping = true
    if (s.keepAlive) {
      clearInterval(s.keepAlive)
      s.keepAlive = null
    }
    if (s.connectTimer) {
      clearTimeout(s.connectTimer)
      s.connectTimer = null
    }
    if (s.stableTimer) {
      clearTimeout(s.stableTimer)
      s.stableTimer = null
    }
    const ws = s.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        // Finalize flushes pending words; CloseStream closes after the server
        // sends the final Results. We keep the socket open briefly so those
        // last words actually reach the UI.
        ws.send(JSON.stringify({ type: 'Finalize' }))
        ws.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (session === s && s.ws && s.ws.readyState === WebSocket.OPEN) {
          try {
            s.ws.close()
          } catch {
            /* ignore */
          }
        }
      }, STOP_FLUSH_MS)
    } else {
      teardown(s)
      session = null
    }
    emit(s, 'transcription:state', { state: 'idle' })
    return { ok: true as const }
  })

  // --- Microphone permission helpers (macOS) --------------------------------
  ipcMain.handle('mic:ensureAccess', async () => {
    if (process.platform !== 'darwin') return { status: 'granted' as const }
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') return { status: 'granted' as const }
    if (status === 'not-determined') {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      return { status: granted ? ('granted' as const) : ('denied' as const) }
    }
    return { status }
  })

  ipcMain.handle('mic:openSettings', async () => {
    await shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    )
    return { ok: true as const }
  })
}
