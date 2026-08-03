import { ipcMain, BrowserWindow, systemPreferences, shell } from 'electron'
import WebSocket from 'ws'
import { keyRejectedHint } from './ai-keys'

const DEEPGRAM_LISTEN_URL = 'wss://api.deepgram.com/v1/listen'
const MAX_CHUNK_BYTES = 1 << 16 // 64 KB safety cap on a single audio frame
const CONNECT_TIMEOUT_MS = 8000 // give up if we never reach 'open'
const STABLE_AFTER_MS = 4000 // connection considered healthy after this long
const STOP_FLUSH_MS = 1500 // wait this long for final words on stop
const KEEPALIVE_MS = 5000
const MAX_RECONNECTS = 3

interface StartOptions {
  sampleRate: number
  /** When true, stream 2 interleaved channels (0=rep, 1=buyer) via Deepgram
   *  multichannel. Defaults to false (mono + diarize) for mic-only calls. */
  multichannel?: boolean
  /** When set, the start only proceeds if the CURRENT session has this id �
   *  so a stale in-flight restart (from an already-stopped call) can never
   *  tear down a newer call's session. Omitted for a brand-new call. */
  expectedSessionId?: number
}

// Everything about one live session lives here, so restarts/reconnects can't
// cross-contaminate (stale timers, stale counters, stale sockets).
interface Session {
  /** Monotonically increasing id � lets restarts prove they target the
   *  session they think they do (see StartOptions.expectedSessionId). */
  id: number
  window: BrowserWindow
  apiKey: string
  sampleRate: number
  /** 1 for mono (mic only) or 2 for multichannel (rep + buyer). */
  channels: number
  /** True when streaming 2 channels with per-channel labels (no diarize). */
  multichannel: boolean
  /** Identifies the SPEAKER-LABEL NAMESPACE these results belong to.
   *
   *  Deepgram restarts diarization from scratch on every new connection, so
   *  "speaker 0" after a reconnect is whoever happens to talk first there — not
   *  the same person as before. The mono(diarize)↔multichannel(channel) swap
   *  changes the meaning of the numbers too. Nothing downstream can tell those
   *  apart from a genuine speaker change, so every result carries the epoch it
   *  was labelled under and consumers refuse to merge or attribute across one. */
  speakerEpoch: number
  ws: WebSocket | null
  keepAlive: ReturnType<typeof setInterval> | null
  connectTimer: ReturnType<typeof setTimeout> | null
  stableTimer: ReturnType<typeof setTimeout> | null
  audioSecondsSent: number
  reconnectAttempts: number
  stopping: boolean
  /** Debug only (see the temporary lag-diagnostic log below): wall-clock time
   *  the session's socket reached 'open', so logged lag can be cross-checked
   *  against real elapsed time. */
  openedAt: number
  /** Debug only: throttles the temporary lag-diagnostic log to ~1/sec. */
  lastLagLogAt: number
}

let session: Session | null = null
let nextSessionId = 1
// Monotonic across the whole app run, so an epoch value is never reused and a
// late/stale result can't be mistaken for the current namespace.
let nextSpeakerEpoch = 1

function emit(s: Session, channel: string, payload: unknown): void {
  if (!s.window.isDestroyed()) {
    s.window.webContents.send(channel, payload)
  }
}

function buildUrl(s: Session): string {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en-US',
    encoding: 'linear16',
    sample_rate: String(s.sampleRate),
    channels: String(s.channels),
    interim_results: 'true', // word-by-word partial results
    smart_format: 'true',
    punctuate: 'true',
    utterance_end_ms: '1000',
    vad_events: 'true'
  })
  // Multichannel labels speakers by channel (0=rep, 1=buyer); for mic-only we
  // fall back to diarization to guess speakers within the single channel.
  if (s.multichannel) params.set('multichannel', 'true')
  else params.set('diarize', 'true')
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
  const ws = new WebSocket(buildUrl(s), {
    headers: { Authorization: `Token ${s.apiKey}` }
  })
  s.ws = ws

  // Watchdog: if we never reach 'open', don't hang in "connecting" forever.
  s.connectTimer = setTimeout(() => {
    if (session === s && ws.readyState !== WebSocket.OPEN) {
      failSession(
        s,
        'Could not reach the transcription service. Check your internet and try again.'
      )
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
    // Deepgram restarts its audio clock per connection � align our counter so
    // the latency math stays correct across reconnects.
    s.audioSecondsSent = 0
    // ...and it restarts DIARIZATION per connection too, so the speaker labels
    // that follow belong to a brand-new namespace. Bumping the epoch here (not
    // only on transcription:start) is what makes a mid-call reconnect safe:
    // without it, post-reconnect "speaker 0" merges straight into a pre-
    // reconnect run for a different person.
    s.speakerEpoch = nextSpeakerEpoch++
    s.openedAt = Date.now()
    s.lastLagLogAt = 0
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
      const alt = (
        msg.channel as
          | {
              alternatives?: Array<{
                transcript?: string
                words?: Array<{
                  speaker?: number
                  word?: string
                  punctuated_word?: string
                  confidence?: number
                }>
              }>
            }
          | undefined
      )?.alternatives?.[0]
      const transcript = alt?.transcript ?? ''
      // In multichannel mode the speaker IS the channel: channel_index[0] is 0
      // (rep) or 1 (buyer). Otherwise fall back to per-word diarization.
      const channelIndex = Array.isArray(msg.channel_index)
        ? (msg.channel_index as unknown[])
        : null
      const channel =
        channelIndex && typeof channelIndex[0] === 'number' ? (channelIndex[0] as number) : null
      const rawWords = alt?.words ?? []
      // In multichannel the speaker IS the channel, so attribution is
      // deterministic and always certain. Under diarization it's a guess, and
      // Deepgram sometimes omits `speaker` entirely — that used to fall through
      // to 0, making "no idea who said this" indistinguishable from "definitely
      // the rep". Track it instead of hiding it.
      const deterministic = s.multichannel && (channel === 0 || channel === 1)
      let speakerCertain = true
      const words = rawWords.map((w) => {
        if (!deterministic && typeof w.speaker !== 'number') speakerCertain = false
        return {
          speaker: deterministic ? channel : typeof w.speaker === 'number' ? w.speaker : 0,
          text: w.punctuated_word ?? w.word ?? ''
        }
      })
      // Lowest per-word confidence in this result — a single badly-heard word is
      // enough to make the whole turn's attribution suspect.
      const confidences = rawWords
        .map((w) => w.confidence)
        .filter((c): c is number => typeof c === 'number' && Number.isFinite(c))
      const minConfidence = confidences.length ? Math.min(...confidences) : null
      const start = typeof msg.start === 'number' ? msg.start : 0
      const duration = typeof msg.duration === 'number' ? msg.duration : 0
      // Real-time lag = how far behind live audio this transcript is.
      const lagMs = Math.max(0, (s.audioSecondsSent - (start + duration)) * 1000)
      // TEMPORARY diagnostic (remove once the Windows multichannel-lag bug is
      // root-caused): compares our own "seconds of audio sent" counter against
      // real wall-clock time since the socket opened, and against Deepgram's
      // own start+duration for this result. If wallClockElapsed and
      // audioSecondsSent diverge, our PCM production is running fast/slow
      // (clock-drift between the mic and loopback sources feeding the
      // AudioContext). If audioSecondsSent tracks wall-clock fine but
      // (start+duration) falls further and further behind BOTH, Deepgram
      // itself is stalling on the multichannel stream, not us.
      const now = Date.now()
      if (now - s.lastLagLogAt > 1000) {
        s.lastLagLogAt = now
        const wallClockSec = (now - s.openedAt) / 1000
        console.log(
          `[transcription:lag-debug] multichannel=${s.multichannel} wallClockSec=${wallClockSec.toFixed(1)} audioSecondsSent=${s.audioSecondsSent.toFixed(1)} dgStart=${start.toFixed(1)} dgDuration=${duration.toFixed(1)} lagMs=${Math.round(lagMs)}`
        )
      }
      emit(s, 'transcription:transcript', {
        transcript,
        words,
        isFinal: msg.is_final === true,
        speechFinal: msg.speech_final === true,
        lagMs,
        speakerEpoch: s.speakerEpoch,
        speakerCertain,
        minConfidence,
        // Multichannel labels are the CHANNEL, so speaker 0 is the rep by
        // construction; diarization labels are a guess with no fixed meaning.
        // Consumers need to tell those apart to know what a label is worth.
        multichannel: s.multichannel
      })
    } else if (msg.type === 'UtteranceEnd') {
      emit(s, 'transcription:utteranceEnd', {})
    }
  })

  ws.on('unexpected-response', (_req, res) => {
    const message =
      res.statusCode === 401
        ? `Your Deepgram API key was rejected. ${keyRejectedHint('DEEPGRAM_API_KEY')}`
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
      // Graceful stop finished flushing � the final words have been sent.
      session = null
      emit(s, 'transcription:closed', {})
      return
    }
    // Unexpected drop � reconnect with exponential backoff.
    if (s.reconnectAttempts < MAX_RECONNECTS) {
      s.reconnectAttempts += 1
      emit(s, 'transcription:state', { state: 'reconnecting', attempt: s.reconnectAttempts })
      const delay = 500 * 2 ** (s.reconnectAttempts - 1)
      setTimeout(() => {
        if (session === s && !s.stopping) connect(s)
      }, delay)
    } else {
      failSession(
        s,
        'Lost connection to the transcription service. Check your internet and try again.'
      )
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

    // A restart that names an expected session must match the CURRENT one �
    // otherwise it's a stale request from an older call and must not clobber
    // the newer session. Return without disposing anything.
    const expected = options?.expectedSessionId
    if (typeof expected === 'number' && session?.id !== expected) {
      return { ok: false, error: 'stale' as const }
    }

    // Replace any previous session entirely.
    disposeTranscription()
    const multichannel = options?.multichannel === true
    const s: Session = {
      id: nextSessionId++,
      window,
      apiKey: key,
      sampleRate: Number(options?.sampleRate) > 0 ? Number(options.sampleRate) : 16000,
      channels: multichannel ? 2 : 1,
      multichannel,
      // Provisional — 'open' assigns the real one. A mono↔multichannel restart
      // lands here, and channel-index labels mean something different from
      // diarization labels, so it must never inherit the old epoch.
      speakerEpoch: nextSpeakerEpoch++,
      ws: null,
      keepAlive: null,
      connectTimer: null,
      stableTimer: null,
      audioSecondsSent: 0,
      reconnectAttempts: 0,
      stopping: false,
      openedAt: Date.now(),
      lastLagLogAt: 0
    }
    session = s
    // TEMPORARY diagnostic (see the lag-debug log above) � marks exactly when
    // a mono<->multichannel restart happens, so the lag-debug log's timeline
    // can be lined up against it.
    console.log(
      `[transcription:lag-debug] new session id=${s.id} multichannel=${multichannel} sampleRate=${s.sampleRate}`
    )
    emit(s, 'transcription:state', { state: 'connecting' })
    connect(s)
    return { ok: true as const, sessionId: s.id }
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
    // 16-bit PCM => 2 bytes per sample, times the channel count (stereo when
    // multichannel) � so the real-time latency math stays correct.
    s.audioSecondsSent += byteLength / 2 / s.channels / s.sampleRate
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
      emit(s, 'transcription:closed', {})
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
    // Each OS has its own deep-link to the microphone privacy pane.
    const url =
      process.platform === 'darwin'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
        : process.platform === 'win32'
          ? 'ms-settings:privacy-microphone'
          : null
    if (!url) return { ok: false as const, error: 'not applicable on this platform' }
    await shell.openExternal(url)
    return { ok: true as const }
  })
}
