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

  // BUG-111 — the rep pressing Pause is not a dead microphone.
  //
  // Pause is renderer-local: `togglePause` only calls `recorder.setPaused(true)`,
  // which stops handing chunks to `sendAudio`. Main therefore sees no audio at
  // all, `lastAudioMs` freezes, and after `noAudioMs` the watchdog declared
  // 'capture-dead' — which ends and saves the call and shows the rep
  // "Microphone disconnected". A 15-second pause cost a live call.
  //
  // Note `setSending(false)` could never have fixed this: the capture-dead
  // branch is evaluated BEFORE the `sending` guard, and deliberately so — a
  // dead microphone matters whether or not we are streaming. Pause needs its
  // own signal, which is what `setCapturePaused` is.
  it('does not declare capture dead while capture is deliberately paused', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onAudio(0, 0.4)
    w.onServerMessage(0)

    w.setCapturePaused(true, 1000)

    // Well past the threshold, with no audio at all — the pre-fix behaviour.
    const verdict = w.evaluate(HEALTH_TUNING.noAudioMs * 3)
    expect(verdict.state).not.toBe('capture-dead')
  })

  // The half that is easy to get wrong: if resuming does not rebase the audio
  // clock, the pause's own silence is still on the books and capture-dead
  // fires on the very next tick — turning a fixed bug into a delayed one.
  it('rebases the audio clock on resume, so the pause itself never counts', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onAudio(0, 0.4)
    w.onServerMessage(0)

    const pausedAt = 1000
    const resumedAt = pausedAt + HEALTH_TUNING.noAudioMs * 3
    w.setCapturePaused(true, pausedAt)
    w.setCapturePaused(false, resumedAt)

    // One tick after resuming, before any real frame has had time to arrive.
    expect(w.evaluate(resumedAt + 1).state).not.toBe('capture-dead')
  })

  // ...and the guard must not become a permanent off switch: a microphone that
  // genuinely dies after a resume still has to be caught.
  it('still declares capture dead after a resume when audio really stops', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.onAudio(0, 0.4)
    w.onServerMessage(0)
    w.setCapturePaused(true, 1000)
    w.setCapturePaused(false, 5000)

    expect(w.evaluate(5000 + HEALTH_TUNING.noAudioMs + 1).state).toBe('capture-dead')
  })

  // A restart must not inherit a stale pause, or the watchdog is silently
  // disarmed for the whole next session.
  it('clears the paused flag on start(), so a restart re-arms the watchdog', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    w.setCapturePaused(true, 1000)

    w.start(10_000)
    w.onServerMessage(10_000)

    expect(w.evaluate(10_000 + HEALTH_TUNING.noAudioMs + 1).state).toBe('capture-dead')
  })

  // The pause flag is the rep's INTENT, and intent outlives a lid-close. The
  // sleep-recovery path in transcription.ts restarts the clocks on a session
  // that is still live, so it has to carry this across by hand — start() alone
  // would clear it and re-arm capture-dead against a still-paused renderer.
  it('exposes the paused flag so sleep recovery can carry it across a restart', () => {
    const w = new LivenessWatchdog()
    w.start(0)
    expect(w.isCapturePaused()).toBe(false)

    w.setCapturePaused(true, 1000)
    expect(w.isCapturePaused()).toBe(true)

    // What the sleep path does: read, restart, re-apply.
    const wasPaused = w.isCapturePaused()
    w.start(50_000)
    expect(w.isCapturePaused()).toBe(false) // start() really does clear it
    if (wasPaused) w.setCapturePaused(true, 50_000)

    expect(w.evaluate(50_000 + HEALTH_TUNING.noAudioMs * 2).state).not.toBe('capture-dead')
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
