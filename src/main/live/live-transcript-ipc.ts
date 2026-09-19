// M26 Phase 4.2 — the recovery surface for interrupted calls.
//
// CONSERVATIVE BY CONSTRUCTION. Nothing in this file decides, on the rep's
// behalf, whether an interrupted call was real. It reports what it found and
// waits. The two silent failure modes are equally bad and point in opposite
// directions — a phantom call that never happened, or a real 40-minute
// conversation thrown away without anyone seeing it — so neither is allowed to
// happen automatically. The rep is asked.
import { BrowserWindow, ipcMain } from 'electron'
import { currentAppVersion } from '../app-version'
import { getCall, saveCall, toSummary, type CallSummary } from '../calls-fs'
import {
  discardJournal,
  listOrphanJournals,
  markJournalRecoveredAsCall,
  readJournal,
  readRecoveredCallId,
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

// BUG-271 — a recovery path with ONE exit cannot tell "a field could not be
// read" from "this call cannot be recovered", and it will do the same thing to
// the next field someone adds (the founder's words; `appVersion` was the
// instance that exposed it). So the path is split by what a failure MEANS:
//
//   DECIDING steps — read the journal, replay it, write the Call record. A
//   failure here means the call was NOT saved, and the result says which step
//   failed, so `{ ok: false }` stops being the only answer.
//
//   CLEANUP steps — mark the journal as recovered, retire it, redact the raw
//   file. They run AFTER the Call record exists. A failure here degrades the
//   tidy-up, never the rescue: the rep is told the call was saved (it was),
//   and the failed step is reported beside it. Before this, a marker write
//   that threw turned a SAVED call into `{ ok: false }` — the rep was told
//   the rescue failed, the journal stayed an orphan with no marker, and the
//   next "Save this call" minted a duplicate.
//
//   `read-call` is the one deciding step that is not about the journal: an
//   earlier attempt already produced a Call record and this attempt could
//   not read it back. Named on its own so the rep is not told the RECORDING
//   was unreadable when it is the saved call that could not be opened.
export type RecoverStep = 'read-journal' | 'read-call' | 'replay' | 'save'
export type RecoverCleanupStep = 'mark-recovered' | 'retire-journal' | 'redact-journal'

export type RecoverOutcome =
  | { ok: true; call: CallSummary; degraded: RecoverCleanupStep[] }
  /** Not a failure: the journal is gone, replays to no words, or points at a
   *  Call that no longer exists. Nothing was lost by this attempt. */
  | { ok: false; reason: 'nothing-to-recover' }
  | { ok: false; reason: 'step-failed'; step: RecoverStep; message: string; cause: unknown }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Run one cleanup step. It can fail; it cannot cost the rescue. */
async function cleanupStep(
  step: RecoverCleanupStep,
  degraded: RecoverCleanupStep[],
  run: () => Promise<unknown>
): Promise<void> {
  try {
    await run()
  } catch (err) {
    degraded.push(step)
    console.error(`[live-transcript] recovery cleanup step "${step}" failed (call is saved):`, err)
  }
}

/** Turn one interrupted call into a real Call record, on the rep's explicit
 *  say-so — and say exactly what happened. */
export async function recoverCallDetailed(id: string, callsDir: string): Promise<RecoverOutcome> {
  const degraded: RecoverCleanupStep[] = []
  const failed = (step: RecoverStep, cause: unknown): RecoverOutcome => ({
    ok: false,
    reason: 'step-failed',
    step,
    message: messageOf(cause),
    cause
  })

  // M27 E2 — idempotency check FIRST. saveCall() below and retireJournal()
  // further down are two separate steps; a crash between them (force-quit,
  // power loss) leaves a journal that still looks like an untouched orphan
  // even though its Call already exists. Recovering it again would mint a
  // SECOND Call for the same conversation — saveCall() always generates a
  // fresh id with nothing linking it back to this journal. If a previous
  // attempt got far enough to record which Call it already produced, finish
  // that interrupted cleanup and hand back the SAME call rather than
  // creating a new one.
  let alreadyRecoveredCallId: string | null
  try {
    alreadyRecoveredCallId = await readRecoveredCallId(id)
  } catch (err) {
    return failed('read-journal', err)
  }
  if (alreadyRecoveredCallId) {
    let existing: Awaited<ReturnType<typeof getCall>>
    try {
      existing = await getCall(callsDir, alreadyRecoveredCallId)
    } catch (err) {
      return failed('read-call', err)
    }
    await cleanupStep('retire-journal', degraded, () => retireJournal(id))
    await cleanupStep('redact-journal', degraded, () => redactJournalConsentIfNeeded(id))
    // The Call record itself is missing (deleted since, or the marker
    // survived a disk problem that ate the actual save) — conservative
    // fallback: report no recoverable call rather than fabricate one.
    return existing
      ? { ok: true, call: toSummary(existing), degraded }
      : { ok: false, reason: 'nothing-to-recover' }
  }

  let journal: Awaited<ReturnType<typeof readJournal>>
  try {
    journal = await readJournal(id)
  } catch (err) {
    return failed('read-journal', err)
  }
  if (!journal) return { ok: false, reason: 'nothing-to-recover' }

  let replayed: ReturnType<typeof replayJournal>
  try {
    replayed = replayJournal(journal)
  } catch (err) {
    return failed('replay', err)
  }
  if (replayed.segments.length === 0) return { ok: false, reason: 'nothing-to-recover' }

  let summary: CallSummary
  try {
    summary = await saveCall(
      callsDir,
      {
        startedAt: replayed.startedAt,
        durationMs: replayed.durationMs,
        segments: replayed.segments,
        // The consent recorded DURING the call, not a fresh default. Passing
        // undefined here would default to recordOtherParty:false and
        // applyConsentRetention would delete the buyer's entire half of a
        // buyer-capture call — silently, at the exact moment the rep asked us
        // to rescue it. saveCall re-sanitizes this, so a tampered journal
        // still cannot grant a permission the call never had. NOT a
        // decoration: consent decides what may be kept, so it stays on the
        // deciding side of the line.
        ...(replayed.consent ? { consent: replayed.consent } : {})
      },
      // M39 — the RECOVERING build's version: that is the build writing this
      // record, which is what `Call.appVersion` claims. A DECORATION, and the
      // model for the next one: read through a helper that cannot throw, so
      // failing to decorate can never cost a rescue.
      { appVersion: currentAppVersion() }
    )
  } catch (err) {
    return failed('save', err)
  }

  // ---- The Call record exists. Nothing below may return a failure. ----------
  // M27 E2 — written BEFORE retireJournal(), which is the whole point: if
  // the process dies between this line and that one, the marker survives
  // (it's its own file, already durably on disk) and the next attempt takes
  // the branch above instead of saving again.
  await cleanupStep('mark-recovered', degraded, () => markJournalRecoveredAsCall(id, summary.id))
  // BUG-189 — retired outright: the Call record is the copy.
  await cleanupStep('retire-journal', degraded, () => retireJournal(id))
  // 1.2.5 hotfix (privacy) — same redaction the normal save path now runs at
  // close time (see live-transcript.ts's endCall), applied here too: the
  // recovered CALL already correctly lacks buyer content when consent didn't
  // permit it (saveCall's own applyConsentRetention, just above) — this only
  // makes any raw file still on disk match what the save already decided. A
  // failure here still can't fail the recovery itself — it only means
  // retirement is retried by the startup sweep.
  await cleanupStep('redact-journal', degraded, () => redactJournalConsentIfNeeded(id))
  return { ok: true, call: summary, degraded }
}

/** The original contract, kept for its callers and its tests: the summary, or
 *  null when there is nothing to recover; throws when a deciding step failed. */
export async function recoverCall(id: string, callsDir: string): Promise<CallSummary | null> {
  const outcome = await recoverCallDetailed(id, callsDir)
  if (outcome.ok) return outcome.call
  if (outcome.reason === 'step-failed') throw outcome.cause
  return null
}

/** What `live:recoverCall` answers — the outcome minus the raw error object,
 *  which does not survive IPC serialisation anyway. */
export type RecoverCallIpcResult =
  | { ok: true; call: CallSummary; degraded: RecoverCleanupStep[] }
  | { ok: false; reason: 'nothing-to-recover' | 'bad-request' }
  | { ok: false; reason: 'step-failed'; step: RecoverStep | 'unknown'; message: string }

export async function recoverCallForIpc(
  id: unknown,
  callsDir: string
): Promise<RecoverCallIpcResult> {
  if (typeof id !== 'string' || !id) return { ok: false, reason: 'bad-request' }
  try {
    const outcome = await recoverCallDetailed(id, callsDir)
    if (outcome.ok) return outcome
    if (outcome.reason === 'nothing-to-recover') return outcome
    console.error(`[live-transcript] recovery failed at "${outcome.step}":`, outcome.cause)
    return { ok: false, reason: 'step-failed', step: outcome.step, message: outcome.message }
  } catch (err) {
    // Unreachable by construction — every step above is individually caught —
    // and kept for exactly the reason this bug exists: the next step someone
    // adds. It still answers with a NAMED failure instead of a bare one.
    console.error('[live-transcript] recovery failed outside any named step:', err)
    return { ok: false, reason: 'step-failed', step: 'unknown', message: messageOf(err) }
  }
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

  // BUG-271 — answers with WHICH step failed, and never reports a saved call
  // as a failure because its tidy-up stumbled. See recoverCallDetailed.
  ipcMain.handle('live:recoverCall', async (_event, id: unknown) => {
    const result = await recoverCallForIpc(id, callsDir())
    // BUG-290 — the record now exists on disk, but no already-mounted screen
    // knew to re-read: useCalls() only refreshes on mount, after its own
    // remove(), or on 'backup:changed'. Reuse that same event rather than
    // inventing a second one - notifyDataChanged's own comment already
    // describes it as "tasks/calls changed on disk, re-read", which is
    // exactly this. A rep sitting on an already-mounted Past Calls list
    // when the interrupted-call prompt fires (e.g. at launch) now sees the
    // recovered call without navigating away and back.
    if (result.ok) {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('backup:changed')
      }
    }
    return result
  })

  ipcMain.handle('live:discardRecoverable', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false as const }
    await discardJournal(id)
    return { ok: true as const }
  })
}
