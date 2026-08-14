// M26 Phase 4.2 — the recovery surface for interrupted calls.
//
// CONSERVATIVE BY CONSTRUCTION. Nothing in this file decides, on the rep's
// behalf, whether an interrupted call was real. It reports what it found and
// waits. The two silent failure modes are equally bad and point in opposite
// directions — a phantom call that never happened, or a real 40-minute
// conversation thrown away without anyone seeing it — so neither is allowed to
// happen automatically. The rep is asked.
import { ipcMain } from 'electron'
import { saveCall, type CallSummary } from '../calls-fs'
import {
  discardJournal,
  listOrphanJournals,
  readJournal,
  redactJournalConsentIfNeeded,
  replayJournal,
  retireJournal
} from './call-journal'
import { liveCallInfo, recordRepIdentified } from './live-transcript'

/** What the rep is shown about one interrupted call, before deciding. Enough
 *  to recognise the conversation — never so much that the prompt itself
 *  becomes a transcript viewer. */
export interface RecoverableCall {
  id: string
  startedAt: string
  durationMs: number
  segmentCount: number
  /** First ~200 characters of speech, so the rep can tell WHICH call this was.
   *  A rep with two interrupted calls must not have to guess. */
  preview: string
  /** The journal's last line was torn by the crash — the call is recoverable
   *  but may be missing its final utterance. Surfaced rather than hidden, so
   *  "why does it stop mid-sentence" has a visible answer. */
  truncated: boolean
}

function preview(segments: Array<{ text: string; kind?: string }>): string {
  return segments
    .filter((s) => s.kind !== 'gap')
    .map((s) => s.text)
    .join(' ')
    .slice(0, 200)
}

/** Every interrupted call awaiting a decision. Safe to call at any time; it
 *  only reads. */
export async function listRecoverableCalls(): Promise<RecoverableCall[]> {
  const orphans = await listOrphanJournals()
  // The call in progress is an orphan by definition — its journal has no
  // completion marker yet, because it has not been saved yet. Offering it would
  // put a "we found an interrupted call" prompt on screen DURING that call,
  // with a Discard button that deletes the journal out from under the process
  // still writing to it. Harmless in 4.2, where the prompt only ran at launch
  // and nothing is ever live then; real from 4.3 on, where attaching mid-call
  // is a supported state.
  const liveId = liveCallInfo()?.callId
  const out: RecoverableCall[] = []
  for (const orphan of orphans) {
    if (orphan.id === liveId) continue
    const replayed = replayJournal(orphan)
    // A journal whose events replay to nothing (all interims, or only a
    // consent line) describes a call in which nobody said anything. Offering
    // to recover it would create exactly the phantom record this module
    // exists to prevent.
    if (replayed.segments.length === 0) continue
    out.push({
      id: orphan.id,
      startedAt: replayed.startedAt,
      durationMs: replayed.durationMs,
      segmentCount: replayed.segments.length,
      preview: preview(replayed.segments),
      truncated: replayed.truncated
    })
  }
  return out
}

/** Turn one interrupted call into a real Call record, on the rep's explicit
 *  say-so. */
export async function recoverCall(id: string, callsDir: string): Promise<CallSummary | null> {
  const journal = await readJournal(id)
  if (!journal) return null
  const replayed = replayJournal(journal)
  if (replayed.segments.length === 0) return null

  const summary = await saveCall(callsDir, {
    startedAt: replayed.startedAt,
    durationMs: replayed.durationMs,
    segments: replayed.segments,
    // The consent recorded DURING the call, not a fresh default. Passing
    // undefined here would default to recordOtherParty:false and
    // applyConsentRetention would delete the buyer's entire half of a
    // buyer-capture call — silently, at the exact moment the rep asked us to
    // rescue it. saveCall re-sanitizes this, so a tampered journal still
    // cannot grant a permission the call never had.
    ...(replayed.consent ? { consent: replayed.consent } : {})
  })
  // Kept under a .recovered name rather than deleted: if the replay produced
  // something wrong, the source is still on disk to look at.
  await retireJournal(id)
  // 1.2.5 hotfix (privacy) — same redaction the normal save path now runs at
  // close time (see live-transcript.ts's endCall), applied here too: the
  // recovered CALL already correctly lacks buyer content when consent didn't
  // permit it (saveCall's own applyConsentRetention, just above) — this only
  // makes the raw .recovered file on disk match what the save already
  // decided, rather than leaving an un-redacted copy behind it. Awaited
  // (unlike the fire-and-forget hot-call-path version) since this is already
  // an async, user-initiated action with no live-call latency budget to
  // protect; a failure here still can't fail the recovery itself — it only
  // means retirement is retried by the startup sweep.
  await redactJournalConsentIfNeeded(id).catch((err) =>
    console.error('[live-transcript] consent redaction failed:', err)
  )
  return summary
}

export function registerLiveTranscriptIpc(callsDir: () => string): void {
  // Renderer-only knowledge, pushed to main (see the call site in
  // useTranscription.identifyRep). `on`, not `handle` — nothing waits on it.
  ipcMain.on('live:repIdentified', (_event, epoch: unknown, speaker: unknown) => {
    if (typeof epoch !== 'number' || typeof speaker !== 'number') return
    if (!Number.isFinite(epoch) || !Number.isFinite(speaker)) return
    recordRepIdentified(epoch, speaker)
  })

  ipcMain.handle('live:listRecoverable', () => listRecoverableCalls())

  ipcMain.handle('live:recoverCall', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false as const }
    try {
      const summary = await recoverCall(id, callsDir())
      return summary ? { ok: true as const, call: summary } : { ok: false as const }
    } catch (err) {
      console.error('[live-transcript] recovery failed:', err)
      return { ok: false as const }
    }
  })

  ipcMain.handle('live:discardRecoverable', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false as const }
    await discardJournal(id)
    return { ok: true as const }
  })
}
