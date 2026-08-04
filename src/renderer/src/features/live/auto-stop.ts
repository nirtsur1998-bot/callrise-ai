// Ending an auto-started call by itself.
//
// A call that starts on its own has to be able to finish on its own. The
// app-name detector (active-app.ts) only ever announces that a call STARTED —
// it has no end signal at all — so an auto-started session ran until someone
// opened the app and pressed Stop. And because the call is only written to
// disk when the session closes, "nobody pressed Stop" meant "the call was
// never saved", which is the worst possible failure: the rep believes it was
// recorded, and there is nothing there.
//
// The honest end signal available to us is the transcript itself. Not silence
// in the audio sense — the liveness probe already reports digital silence
// within ten seconds, and a quiet stretch is not the end of a call — but a
// sustained absence of any transcribed WORDS. Nobody has said anything for
// minutes, so whatever is still being captured is a room, not a conversation.
//
// The threshold is deliberately generous. Real calls contain long pauses:
// someone is put on hold, pulls up a document, takes another call. Stopping
// early truncates a live conversation, which is a worse outcome than recording
// a few extra minutes of nothing. Five minutes is comfortably past any pause
// that occurs inside a real sales call while still bounding the damage from a
// session everyone has forgotten about.

/** No transcribed speech for this long ends an auto-started call. */
export const IDLE_STOP_MS = 5 * 60_000

export interface IdleDecision {
  /** True on the single evaluation where the call should be wrapped up. */
  stop: boolean
  /** How long it has been since anyone said anything. */
  idleMs: number
}

/**
 * Watches an auto-started session for the point where it has clearly ended.
 *
 * Only ever armed for calls the app started by itself. A rep who pressed Start
 * is present and in control of their own session; timing them out mid-thought
 * would be a surprise, and it is not the problem this solves.
 */
export class IdleStopWatcher {
  private readonly idleMs: number
  private lastSpeechAtMs: number | null = null
  private armed = false
  private fired = false

  constructor(idleMs: number = IDLE_STOP_MS) {
    this.idleMs = idleMs
  }

  /** Begin watching. `atMs` seeds the clock, so a call that never produces a
   *  single word still ends rather than running forever. */
  arm(atMs: number): void {
    this.armed = true
    this.fired = false
    this.lastSpeechAtMs = atMs
  }

  /** Stop watching — the session ended, or was never auto-started. */
  disarm(): void {
    this.armed = false
    this.fired = false
    this.lastSpeechAtMs = null
  }

  get isArmed(): boolean {
    return this.armed
  }

  /** Somebody said something. Only call this for transcript text that is
   *  genuinely non-empty — an empty final would reset the clock forever. */
  noteSpeech(atMs: number): void {
    if (this.armed) this.lastSpeechAtMs = atMs
  }

  evaluate(atMs: number): IdleDecision {
    if (!this.armed || this.lastSpeechAtMs === null) return { stop: false, idleMs: 0 }
    const idleMs = atMs - this.lastSpeechAtMs
    // Latched: the stop it triggers is asynchronous, so without this the next
    // evaluation would fire again before the session has finished closing.
    if (this.fired || idleMs < this.idleMs) return { stop: false, idleMs }
    this.fired = true
    return { stop: true, idleMs }
  }
}

/** The notice shown after an auto-stop, so the rep is never left guessing why
 *  a call ended on its own. */
export function idleStopNotice(idleMs: number): string {
  const minutes = Math.max(1, Math.round(idleMs / 60_000))
  return `Call saved — no one had spoken for ${minutes} minutes.`
}
