// M26 Phase 4.2/4.3 — the call in progress, owned by the main process.
//
// 4.1 built the accumulator; nothing consumed it. 4.2 paired it with an
// append-only journal so the transcript existed in two places that fail
// independently. 4.3 made it THE transcript: the renderer no longer
// accumulates anything, it mirrors what this module publishes, and what gets
// saved to disk comes from here rather than from a React ref.
//
// That last change is the point of the whole phase. The transcript used to
// live in exactly one place — a ref inside a component that unmounts on every
// navigation — which is why a crash, a force-quit, or a sidebar click could
// lose a real customer conversation.
//
// THE INVARIANT THIS MODULE ENFORCES: journaling can never break a call.
// Every entry point swallows its own failures and returns void. There is
// nothing here a caller is expected to await, check, or handle. If the disk is
// full the call runs exactly as it did before this file existed — it simply
// has no safety net. Same rule as "a Sales Brain failure can never take down a
// save", and it is why the wiring in transcription.ts is a bare call with no
// surrounding logic.
//
// A CALL IS NOT A SESSION. `transcription.ts` disposes and recreates its
// Session on a mono<->multichannel switch, and the renderer keeps one
// transcript across that. So the journal is keyed to the CALL and deliberately
// survives session restarts — see begin()'s `restart` argument. Getting this
// wrong would end every buyer-capture call with a spurious "we found an
// interrupted call" prompt for a call that saved perfectly well.
import { randomUUID } from 'node:crypto'
import { CallJournal } from './call-journal'
import {
  TranscriptAccumulator,
  type AccumulatedSegment,
  type TranscriptResult
} from './transcript-accumulator'
import { diffFrom, type TranscriptPatch } from './transcript-patch'
import type { ConsentRecord } from '../calls-fs'

interface LiveCall {
  id: string
  /** Null when the journal could not be opened. The transcript still
   *  accumulates — see beginCall for why that distinction became critical
   *  in 4.3. */
  journal: CallJournal | null
  acc: TranscriptAccumulator
  startedAt: string
  /** Wall-clock start, used to stamp each event with an offset so a recovered
   *  call has a real duration rather than a zero. */
  startedAtMs: number
  seq: number
  /** The version the renderer has already been told about, so each change can
   *  be sent as a splice rather than as a whole array. */
  lastPublished: AccumulatedSegment[]
}

let current: LiveCall | null = null

/** Injected by transcription.ts. A callback rather than a direct
 *  `webContents.send` so this module stays electron-free and testable. */
let listener: ((patch: TranscriptPatch) => void) | null = null

export function setTranscriptListener(fn: ((patch: TranscriptPatch) => void) | null): void {
  listener = fn
}

function at(call: LiveCall): number {
  return Math.max(0, Math.round(Date.now() - call.startedAtMs))
}

/**
 * Tell the renderer what changed, if anything.
 *
 * Staying SILENT when nothing changed is deliberate and load-bearing. The
 * renderer re-arms its 5-minute "nobody has said anything, end the call" timer
 * whenever the segments array identity changes. Publishing on every result —
 * including the many that produce no new turn — would hand it a fresh array
 * forever and auto-stop would become unreachable for the life of the call.
 */
function publish(call: LiveCall): void {
  try {
    const next = call.acc.snapshot()
    const from = diffFrom(call.lastPublished, next)
    if (from < 0) return
    call.lastPublished = next
    call.seq += 1
    listener?.({ callId: call.id, seq: call.seq, from, segments: next.slice(from) })
  } catch (err) {
    // Same rule as every other entry point here: publishing can never break a
    // call. The renderer's own sequence check turns a missed patch into a
    // re-attach, so the worst case is an extra round-trip, not a wrong
    // transcript.
    console.error('[live-transcript] could not publish transcript patch:', err)
  }
}

/**
 * A call is starting.
 *
 * `restart` distinguishes a mid-call session replacement (mono<->multichannel)
 * from a genuinely new call. On a restart the existing journal and accumulated
 * transcript are kept, because that is one call from the rep's point of view
 * and from the renderer's.
 */
export function beginCall(opts: { restart: boolean }): void {
  if (opts.restart && current) {
    // Same call, new label namespace. The swap changes what a speaker number
    // MEANS, so whatever comes next must start a fresh turn rather than
    // merging into the previous regime's segments.
    //
    // This is now the ONLY place that boundary is armed. The renderer used to
    // arm its own, at subtly different moments in each direction — before the
    // restart await when switching buyer capture off, after it when switching
    // on — so a restart that failed or was superseded left the two copies
    // permanently disagreeing about where one turn ended.
    markSpeakerBoundary()
    return
  }
  endCall({ saved: false })
  const startedAtMs = Date.now()
  const id = randomUUID()
  const startedAt = new Date(startedAtMs).toISOString()

  // The accumulator is created FIRST and unconditionally, and the journal is
  // allowed to fail on its own.
  //
  // Before 4.3 a throw here set `current = null`, which cost the call its
  // safety net — bad, but survivable, because the renderer still held the
  // transcript. In 4.3 this accumulator IS the transcript, so the same throw
  // would mean no transcript anywhere: a total-loss path that has never
  // existed in this app, introduced by an unwritable disk. The journal is
  // optional; the accumulator is not.
  let journal: CallJournal | null = null
  try {
    journal = CallJournal.open(id, { startedAt })
  } catch (err) {
    console.error('[live-transcript] could not open a journal, call continues:', err)
  }
  current = {
    id,
    journal,
    acc: new TranscriptAccumulator(),
    startedAt,
    startedAtMs,
    seq: 0,
    lastPublished: []
  }
  // seq 0 with from 0 is the reset marker: it tells a renderer already
  // mirroring a previous call to drop it rather than splice into it.
  try {
    listener?.({ callId: id, seq: 0, from: 0, segments: [] })
  } catch (err) {
    console.error('[live-transcript] could not announce the new call:', err)
  }
}

/** One finalized Deepgram result. Called from transcription.ts's result path,
 *  on the hot path, several times a minute. */
export function recordResult(payload: TranscriptResult): void {
  const call = current
  if (!call) return
  try {
    // Interims are the majority of results and change nothing on replay, so
    // they are dropped BEFORE the write rather than after — journaling them
    // would multiply the file size for no recoverable information.
    if (!payload.isFinal) return
    call.acc.ingest(payload)
    call.journal?.append({ t: 'result', at: at(call), p: payload })
    publish(call)
  } catch (err) {
    console.error('[live-transcript] result not journaled:', err)
  }
}

/** Audio that will never be transcribed, recorded inline so a recovered
 *  transcript shows an honest hole rather than splicing two distant moments. */
export function recordGap(marker: string): void {
  const call = current
  if (!call) return
  try {
    call.acc.ingestGap(marker)
    call.journal?.append({ t: 'gap', at: at(call), marker })
    publish(call)
  } catch (err) {
    console.error('[live-transcript] gap not journaled:', err)
  }
}

export function markSpeakerBoundary(): void {
  const call = current
  if (!call) return
  try {
    call.acc.markSpeakerBoundary()
    call.journal?.append({ t: 'boundary', at: at(call) })
  } catch (err) {
    console.error('[live-transcript] boundary not journaled:', err)
  }
}

/** The coaching engine worked out which speaker is the rep. Renderer-side
 *  knowledge, so it arrives over IPC — without it a recovered transcript is
 *  still complete, but every turn reads as 'unknown' instead of rep/other. */
export function recordRepIdentified(epoch: number, speaker: number): void {
  const call = current
  if (!call) return
  try {
    call.acc.identifyRep(epoch, speaker)
    call.journal?.append({ t: 'rep', at: at(call), epoch, speaker })
    publish(call)
  } catch (err) {
    console.error('[live-transcript] rep identification not journaled:', err)
  }
}

/** Buyer-capture consent, at the moment it is granted or withdrawn. See the
 *  long note on JournalEvent's 'consent' case for why this is load-bearing
 *  rather than metadata. */
export function recordConsent(consent: ConsentRecord | null): void {
  const call = current
  if (!call) return
  try {
    call.journal?.append({ t: 'consent', at: at(call), c: consent })
  } catch (err) {
    console.error('[live-transcript] consent not journaled:', err)
  }
}

// M26 Phase 4.4 — closes a race that main gaining its own end-of-call
// trigger (render-process-gone, a fault threshold) introduces.
//
// Before 4.4, endCall({saved:true}) was called from exactly one place —
// calls.ts's calls:save handler, after a successful save — so there was
// never a second, concurrent caller. Once main can independently decide a
// call is over WHILE a save is still in flight, that stops being true: if
// render-process-gone fires mid-await, it would call
// endCall({saved:false}) and null `current` FIRST; when the in-flight save
// then resolves and calls endCall({saved:true}), `current` is already
// null, so THAT call is a no-op — the journal never gets its `.done`
// marker despite a real Call record now existing on disk. Next launch,
// listOrphanJournals() offers it as recoverable, and saving it again mints
// a second Call record for the same conversation.
//
// The fix: a save in flight wins. A main-initiated saved:false during that
// window is deferred to a no-op — the save's own eventual saved:true is
// authoritative, because it corresponds to a real, successful write.
let saveInFlight = false

/** Call before awaiting saveCall(). */
export function beginSave(): void {
  saveInFlight = true
}

/** Call in a `finally` after saveCall() settles, success or failure. */
export function endSave(): void {
  saveInFlight = false
}

/**
 * The call is over.
 *
 * `saved: true` marks the journal complete, so it stops being a recovery
 * candidate. `saved: false` leaves it as one — which is the correct outcome
 * for a call the rep abandoned mid-way as well as for one that crashed, and
 * the rep gets asked either way rather than the app guessing.
 */
export function endCall(opts: { saved: boolean }): void {
  if (!opts.saved && saveInFlight) return
  const call = current
  current = null
  if (!call) return
  try {
    if (opts.saved) call.journal?.complete()
    else call.journal?.close()
  } catch (err) {
    console.error('[live-transcript] could not close journal:', err)
  }
}

/** Main's copy of the transcript so far — as of 4.3, THE transcript. The
 *  renderer mirrors this; it no longer builds its own. Callers must not mutate
 *  the returned array (every internal update is copy-on-write). */
export function currentTranscript(): ReturnType<TranscriptAccumulator['snapshot']> {
  return current?.acc.snapshot() ?? []
}

/** Identity and progress of the call in progress, without its segments — for
 *  attach snapshots and for anything that needs to know which call is live
 *  without copying a 45-minute transcript to ask. */
export function liveCallInfo(): {
  callId: string
  startedAt: string
  startedAtMs: number
  seq: number
} | null {
  if (!current) return null
  return {
    callId: current.id,
    startedAt: current.startedAt,
    startedAtMs: current.startedAtMs,
    seq: current.seq
  }
}

export function hasLiveCall(): boolean {
  return current !== null
}

/** Test seam — drops any in-progress call without touching disk. */
export function resetLiveTranscriptForTests(): void {
  try {
    current?.journal?.close()
  } catch {
    /* nothing to close */
  }
  current = null
  listener = null
  saveInFlight = false
}
