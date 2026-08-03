import { describe, expect, it } from 'vitest'
import { LivenessWatchdog, silenceFrame } from '../liveness'
import { HEALTH_TUNING } from '../types'

describe('LivenessWatchdog', () => {
  it('is ok while audio and server messages both flow', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    for (let t = 0; t <= 30_000; t += 1000) {
      w.onAudio(t, 0.4)
      w.onServerMessage(t)
      expect(w.evaluate(t).state).toBe('ok')
    }
  })

  it('declares capture dead when callbacks stop', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onAudio(0, 0.4)
    w.onServerMessage(0)
    const verdict = w.evaluate(HEALTH_TUNING.noAudioMs + 1)
    expect(verdict.state).toBe('capture-dead')
    expect(verdict.forMs).toBeGreaterThanOrEqual(HEALTH_TUNING.noAudioMs)
  })

  // readyState === OPEN is not a liveness check: a half-open TCP socket keeps
  // reporting OPEN for the whole retransmit window while nothing gets through.
  it('declares the socket dead when the server goes quiet while we stream', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onServerMessage(0)
    for (let t = 1000; t <= HEALTH_TUNING.noServerMessageMs + 1000; t += 1000) {
      w.onAudio(t, 0.4)
      w.onSubmitted(t)
    }
    expect(w.evaluate(HEALTH_TUNING.noServerMessageMs + 1000).state).toBe('socket-dead')
  })

  it('does not blame the server while we are deliberately not sending', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onServerMessage(0)
    w.setSending(false)
    for (let t = 1000; t <= 30_000; t += 1000) w.onAudio(t, 0.4)
    expect(w.evaluate(30_000).state).toBe('ok')
  })

  // A quiet meeting and a broken capture are indistinguishable from in here,
  // so silence is surfaced but never acted on.
  it('flags sustained digital silence without calling it dead', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    for (let t = 0; t <= HEALTH_TUNING.silentAudioMs + 1000; t += 500) {
      w.onAudio(t, 0)
      w.onServerMessage(t)
    }
    const verdict = w.evaluate(HEALTH_TUNING.silentAudioMs + 1000)
    expect(verdict.state).toBe('silent')
  })

  it('clears the silence flag as soon as anyone speaks', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    for (let t = 0; t <= HEALTH_TUNING.silentAudioMs + 1000; t += 500) {
      w.onAudio(t, 0)
      w.onServerMessage(t)
    }
    const t = HEALTH_TUNING.silentAudioMs + 1500
    w.onAudio(t, 0.5)
    w.onServerMessage(t)
    expect(w.evaluate(t).state).toBe('ok')
  })

  it('prioritises dead capture over dead socket', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onSubmitted(0)
    const t = Math.max(HEALTH_TUNING.noAudioMs, HEALTH_TUNING.noServerMessageMs) + 1000
    expect(w.evaluate(t).state).toBe('capture-dead')
  })

  it('restarts every clock on a new connection', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onSubmitted(0)
    const late = HEALTH_TUNING.noServerMessageMs + 5_000
    w.onAudio(late, 0.4)
    w.onConnectionOpen(late)
    expect(w.evaluate(late).state).toBe('ok')
  })
})

describe('silence fill', () => {
  // Deepgram closes with 1011 / NET-0001 when no audio arrives shortly after a
  // socket opens, and KeepAlive does not satisfy that deadline. A paused call
  // must keep sending real (silent) PCM or the session dies on resume.
  it('comes due well before Deepgram’s no-audio deadline', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onAudio(0, 0.3)
    expect(w.needsSilenceFill(HEALTH_TUNING.silenceFillMs - 1)).toBe(false)
    expect(w.needsSilenceFill(HEALTH_TUNING.silenceFillMs)).toBe(true)
    expect(HEALTH_TUNING.silenceFillMs).toBeLessThan(HEALTH_TUNING.noServerMessageMs)
  })

  it('is not due before the session starts', () => {
    expect(new LivenessWatchdog().needsSilenceFill(60_000)).toBe(false)
  })

  it('throttles repeat fills without masking dead capture', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onAudio(0, 0.3)

    const first = HEALTH_TUNING.silenceFillMs
    expect(w.needsSilenceFill(first)).toBe(true)
    w.noteSilenceFill(first)
    expect(w.needsSilenceFill(first + 100)).toBe(false)
    expect(w.needsSilenceFill(first + HEALTH_TUNING.silenceFillMs)).toBe(true)

    // Fills keep the socket fed, but real audio has still been absent long
    // enough that the capture itself must be reported as dead.
    const dead = HEALTH_TUNING.noAudioMs + 1
    w.noteSilenceFill(dead)
    expect(w.evaluate(dead).state).toBe('capture-dead')
  })

  it('builds a correctly sized, genuinely non-empty silent frame', () => {
    const mono = silenceFrame(100, 1, 16000)
    expect(mono.byteLength).toBe(0.1 * 16000 * 2)
    expect(new Int16Array(mono).every((s) => s === 0)).toBe(true)

    const stereo = silenceFrame(100, 2, 16000)
    expect(stereo.byteLength).toBe(mono.byteLength * 2)
  })

  // A zero-length send is read as end-of-stream, not as silence.
  it('never produces a zero-length frame', () => {
    expect(silenceFrame(0, 1, 16000).byteLength).toBeGreaterThan(0)
  })
})
