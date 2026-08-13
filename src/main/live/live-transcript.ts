// M26 Phase 4.2 — the main process's own copy of the call in progress.
//
// 4.1 built the accumulator; nothing consumed it. This module is what consumes
// it: it pairs the in-memory accumulator with an on-disk journal, so the
// transcript exists in two places that fail independently. The renderer is
// still the source of truth for display and for saving (4.3 changes that) —
// what changes here is that a call is no longer lost when the renderer, or the
// whole process, goes away.
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
import { TranscriptAccumulator, type TranscriptResult } from './transcript-accumulator'
import type { ConsentRecord } from '../calls-fs'

interface LiveCall {
  journal: CallJournal
  acc: TranscriptAccumulator
  /** Wall-clock start, used to stamp each event with an offset so a recovered
   *  call has a real duration rather than a zero. */
  startedAtMs: number
}

let current: LiveCall | null = null

function at(call: LiveCall): number {
  return Math.max(0, Math.round(Date.now() - call.startedAtMs))
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
  try {
    if (opts.restart && current) {
      // Same call, new label namespace. The swap changes what a speaker
      // number MEANS, so whatever comes next must start a fresh turn rather
      // than merging into the previous regime's segments.
      markSpeakerBoundary()
      return
    }
    endCall({ saved: false })
    const startedAtMs = Date.now()
    const id = randomUUID()
    current = {
      journal: CallJournal.open(id, { startedAt: new Date(startedAtMs).toISOString() }),
      acc: new TranscriptAccumulator(),
      startedAtMs
    }
  } catch (err) {
    current = null
    console.error('[live-transcript] could not begin, continuing without a journal:', err)
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
    call.journal.append({ t: 'result', at: at(call), p: payload })
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
    call.journal.append({ t: 'gap', at: at(call), marker })
  } catch (err) {
    console.error('[live-transcript] gap not journaled:', err)
  }
}

export function markSpeakerBoundary(): void {
  const call = current
  if (!call) return
  try {
    call.acc.markSpeakerBoundary()
    call.journal.append({ t: 'boundary', at: at(call) })
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
    call.journal.append({ t: 'rep', at: at(call), epoch, speaker })
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
    call.journal.append({ t: 'consent', at: at(call), c: consent })
  } catch (err) {
    console.error('[live-transcript] consent not journaled:', err)
  }
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
  const call = current
  current = null
  if (!call) return
  try {
    if (opts.saved) call.journal.complete()
    else call.journal.close()
  } catch (err) {
    console.error('[live-transcript] could not close journal:', err)
  }
}

/** Main's copy of the transcript so far. Read-only to callers; 4.3 makes this
 *  the source of truth the renderer renders from. */
export function currentTranscript(): ReturnType<TranscriptAccumulator['snapshot']> {
  return current?.acc.snapshot() ?? []
}

export function hasLiveCall(): boolean {
  return current !== null
}

/** Test seam — drops any in-progress call without touching disk. */
export function resetLiveTranscriptForTests(): void {
  try {
    current?.journal.close()
  } catch {
    /* nothing to close */
  }
  current = null
}
