// M26 Phase 4.5.1 — a main-owned, poll-based tap on transcript results,
// including interim/non-final partials, independent of live-transcript.ts's
// accumulator/journal.
//
// live-transcript.ts's recordResult() deliberately drops interim results
// before writing (see its own comment there) — journaling every partial
// would multiply the journal size for no recoverable information, and that
// stays correct and unchanged. But the cue engine's fast tier (battlecard
// matching, see useLiveCues.ts's onTranscript handler) needs exactly what
// gets dropped: the ROLLING PARTIAL, updated several times a second, not
// just the finalized turn. subscribeTranscript() (4.5.0) can't serve this —
// it fans out live-transcript's own publish() stream, which is
// finals-only by construction.
//
// THE HARD CONSTRAINT (design doc M26-phase4.5-design.md §6A): the cue
// engine's own logic must never run as a synchronous inline call inside
// transcription.ts's ws.on('message') handler, because a throw there is
// caught by the SAME fault counter that guards the socket
// (reportFault/failSession, 3 faults/5000ms) — three cue-engine bugs in five
// seconds would end the whole live call over what should have been "no cue
// this cycle". So this module is a passive buffer, not a callback registry:
// transcription.ts's message handler only ever WRITES here (a plain
// assignment — cannot throw, cannot block), and everything that READS it —
// the cue engine's own independently-scheduled poll, once it moves into
// main in 4.5.4 — does so on its own timer, entirely outside that try block.
export interface InterimWord {
  speaker: number
  text: string
  /** 0 = the rep's mic, 1 = the other party. Absent on mono calls. */
  channel?: number
}

/** Same shape as preload's TranscriptResultEvent (src/preload/index.d.ts) —
 *  deliberately, so a future poller sees byte-for-byte what the renderer's
 *  onTranscript handler receives today. Kept as a separate declaration
 *  rather than imported from preload: main does not depend on preload's
 *  types, preload already depends on main's (see transcript-patch.ts). */
export interface InterimTranscriptResult {
  transcript: string
  words: InterimWord[]
  isFinal: boolean
  speechFinal: boolean
  speakerEpoch: number
  speakerCertain: boolean
  minConfidence: number | null
  multichannel: boolean
}

let latest: InterimTranscriptResult | null = null
let seq = 0

/** Called from transcription.ts's ws.on('message') handler, once per
 *  Results message — including non-final partials, unlike live-transcript's
 *  recordResult(). Deliberately just a plain assignment: no listeners to
 *  fan out to, nothing that can throw. */
export function recordInterim(result: InterimTranscriptResult): void {
  latest = result
  seq += 1
}

/** The most recent Results message, final or not, paired with a sequence
 *  number a poller can use to tell "nothing new since I last looked" apart
 *  from a genuine update without re-processing an unchanged result. Null
 *  before the first message of a call arrives, and after resetInterim(). */
export function latestInterim(): { seq: number; result: InterimTranscriptResult } | null {
  return latest ? { seq, result: latest } : null
}

/** Called from live-transcript.ts's beginCall()/endCall() — the real
 *  session lifecycle, never a renderer attach/detach event — so a poller
 *  starting on a new call can never read a stale interim left over from the
 *  one before it. */
export function resetInterim(): void {
  latest = null
  seq = 0
}
