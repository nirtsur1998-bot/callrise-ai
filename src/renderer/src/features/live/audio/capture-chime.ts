// Audible confirmation that buyer-side capture actually went live.
//
// The recording indicator (RecordingIndicator.tsx) already says "you + the
// other party" the instant capture starts — but that only helps a rep who is
// looking at the screen. A rep who glanced away right when the buyer picked
// up, or who has the window behind something else, gets no signal at all that
// the switch from "your mic" to "both sides" actually happened. A short, quiet
// two-note chime closes that gap without demanding attention: it's for the
// rep's own confidence that consent-gated capture is doing what the UI claims,
// not a notification that needs acting on.
//
// Deliberately NOT tied to a Settings toggle. This announces a fact about
// capture state to the person running it, the same category as the visual
// indicator it already can't opt out of — adding a switch to silence it would
// let "did buyer capture actually start" become something the rep has no way
// to notice.

/** Pure edge-detector: true only on the exact transition into "live" — never
 *  on every render where it's already true, and never on the way down. */
export function capturedJustWentLive(wasLive: boolean, isLive: boolean): boolean {
  return isLive && !wasLive
}

const NOTES_HZ = [660, 880] // a short rising interval — "connected", not an alarm
const NOTE_MS = 90
const GAP_MS = 40

/**
 * Play the two-note confirmation chime.
 *
 * Builds and tears down its own `AudioContext` per call rather than sharing
 * one with the recorder: this fires at most a couple of times per call, so
 * the cost of a fresh context is negligible, and keeping it separate means a
 * bug here can never touch the audio graph that's actually being transcribed.
 */
export function playCaptureLiveChime(): void {
  try {
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return
    const ctx = new AudioContextCtor()
    const start = ctx.currentTime

    NOTES_HZ.forEach((hz, i) => {
      const at = start + (i * (NOTE_MS + GAP_MS)) / 1000
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = hz
      // A quick fade in/out avoids an audible click at the note's edges.
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(0.12, at + 0.01)
      gain.gain.linearRampToValueAtTime(0, at + NOTE_MS / 1000)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + NOTE_MS / 1000 + 0.01)
    })

    const totalMs = NOTES_HZ.length * (NOTE_MS + GAP_MS) + 100
    setTimeout(() => void ctx.close(), totalMs)
  } catch {
    // Best-effort. A failed chime must never take down the call itself.
  }
}
