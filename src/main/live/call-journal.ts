// M26 Phase 4.2 — an append-only journal of a live call, on disk, written as
// the call happens.
//
// WHY: a call's transcript is written to disk exactly once, at the end. A
// force-quit at minute 42 of a 45-minute call therefore loses all 42 — there
// is nothing on disk to recover from, because nothing was ever written. No
// amount of save-on-the-way-down fixes that: on a hard kill (Task Manager,
// power loss) no JavaScript runs at all. The only structural answer is to have
// already written it.
//
// EVENT-SOURCED, NOT SEGMENT-SOURCED. The obvious design — append each new
// segment — does not work: merging a continued turn REWRITES the previous
// segment (`mergeSegments`), which an append-only file cannot express. So the
// journal records the INPUT events instead, and recovery replays them through
// the same TranscriptAccumulator the live call used. That accumulator is a
// pure reducer with no clock and no randomness, so a replay is exact rather
// than approximate.
//
// THE HARD INVARIANT — journaling must never be able to break a call.
// Every write here is fire-and-forget and swallows its own failure. A full
// disk, a slow disk, a permissions problem, an antivirus lock: the live call
// continues completely unaffected and simply loses its safety net. This is the
// same rule as "a Sales Brain failure can never take down a call save", and it
// is why nothing in this module returns a promise the caller is expected to
// await on the hot path.
import { app } from 'electron'
import { join } from 'node:path'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isOtherPartySpeaker, type ConsentRecord } from '../calls-fs'
import {
  TranscriptAccumulator,
  type AccumulatedSegment,
  type TranscriptResult
} from './transcript-accumulator'

/** One recorded input event. Replaying these in order through a fresh
 *  TranscriptAccumulator reproduces the transcript exactly.
 *
 *  Keys are short because this is written several times a minute for the whole
 *  length of every call; `at` is milliseconds since the call started, which is
 *  what lets a recovered call carry a real duration instead of a zero. */
export type JournalEvent =
  | { t: 'result'; at: number; p: TranscriptResult }
  | { t: 'gap'; at: number; marker: string }
  | { t: 'boundary'; at: number }
  | { t: 'rep'; at: number; epoch: number; speaker: number }
  /**
   * Recording consent, as it stood at this moment.
   *
   * CARRIED IN THE JOURNAL ON PURPOSE — this is load-bearing, not metadata.
   * `applyConsentRetention` (calls-fs.ts:758) strips every channel-tagged
   * buyer segment from any call whose `recordOtherParty` is not true. A
   * recovered call saved with the default consent record would therefore have
   * half of a buyer-capture conversation deleted at the instant of recovery,
   * silently — the precise failure this whole phase exists to prevent.
   *
   * It cannot be read back from `active-consent.json` at recovery time
   * either: that file is deliberately cleared on every app start, so a grant
   * left behind by a crash can never authorise the NEXT call (consent-gate.ts
   * :19-21). That invariant is correct and is not weakened here — instead the
   * grant is copied into the journal at the moment it is made, where it
   * describes only the call it belongs to and can authorise nothing else.
   *
   * Last one wins on replay: consent can be revoked mid-call, and the strip is
   * keyed on the final flag rather than the status history.
   */
  | { t: 'consent'; at: number; c: ConsentRecord | null }

/** The first line of every journal. Carries what the eventual Call record
 *  needs but the event stream does not. */
export interface JournalHeader {
  v: 1
  callJournalId: string
  startedAt: string
}

/** Overridable so journaling and recovery can be tested without an Electron
 *  app object — the same seam, for the same reason, as consent-gate.ts's
 *  setConsentGateDirForTests. */
let baseDir: string | null = null

export function setCallJournalsDirForTests(dir: string | null): void {
  baseDir = dir
}

function journalsDir(): string {
  return join(baseDir ?? app.getPath('userData'), 'call-journals')
}

/** `.done` marks a journal whose call was saved normally. Kept as a separate
 *  marker file rather than a line inside the journal, so that "was this call
 *  completed?" can be answered without reading — and without trusting — a file
 *  that may have been torn mid-write by the very crash we are recovering from. */
function donePath(id: string): string {
  return join(journalsDir(), `${id}.done`)
}

function journalPath(id: string): string {
  return join(journalsDir(), `${id}.jsonl`)
}

function recoveredPath(id: string): string {
  return `${journalPath(id)}.recovered`
}

// 1.2.5 hotfix (privacy) — marks a journal the consent-redaction pass has
// already processed, whether or not a rewrite was actually needed. Separate
// from `.done`/`.recovered`, which describe the CALL's fate, not the
// journal's redaction status — a journal can be `.done` for months before
// this fix ships and only get this marker the first time it's checked.
function redactedMarkerPath(id: string): string {
  return join(journalsDir(), `${id}.redacted`)
}

/**
 * One live call's journal writer.
 *
 * WRITE-THROUGH, NOT BUFFERED. An earlier version of this used
 * createWriteStream, on the reasonable-sounding grounds that one open handle
 * is cheaper than an open/write/close per event. It was wrong for this job,
 * and the recovery tests caught it: a stream holds the last writes in a
 * userspace buffer, and a force-quit — the exact thing being defended against
 * — does not flush it. The journal came back EMPTY from a call with three
 * minutes of speech in it. A safety net that a hard kill can empty is not a
 * safety net, so every event goes straight to the OS with appendFileSync.
 *
 * The cost is genuinely nothing: a finalized Deepgram result arrives a few
 * times a minute, this is ~200 bytes, and it runs on main's IPC path rather
 * than anywhere near the audio path.
 */
export class CallJournal {
  private failed = false
  readonly id: string

  private constructor(id: string) {
    this.id = id
  }

  /** Open a journal for a new call. Never throws: if the journal cannot be
   *  created, the returned instance is inert and every later call is a no-op,
   *  so the call proceeds with no safety net rather than not proceeding. */
  static open(id: string, header: Omit<JournalHeader, 'v' | 'callJournalId'>): CallJournal {
    const journal = new CallJournal(id)
    try {
      mkdirSync(journalsDir(), { recursive: true })
      journal.writeLine({ v: 1, callJournalId: id, ...header } satisfies JournalHeader)
    } catch (err) {
      journal.failed = true
      console.error('[call-journal] could not open, continuing without a journal:', err)
    }
    return journal
  }

  private writeLine(value: unknown): void {
    if (this.failed) return
    try {
      appendFileSync(journalPath(this.id), `${JSON.stringify(value)}\n`, 'utf8')
    } catch (err) {
      // Latch the failure rather than retrying every event: a disk that is
      // full at minute 5 is full at minute 6, and a per-event console.error
      // for the rest of a 45-minute call is its own problem.
      this.failed = true
      console.error('[call-journal] write failed, continuing without a journal:', err)
    }
  }

  /** Record one input event. Fire-and-forget by design — see the file header. */
  append(event: JournalEvent): void {
    this.writeLine(event)
  }

  /** The call was saved normally, so this journal is no longer a recovery
   *  candidate. Writes a marker rather than deleting immediately: if the save
   *  itself is what failed, the journal is the last copy and must survive.
   *
   *  writeFileSync, not createWriteStream: a stream reports a bad path via an
   *  asynchronous 'error' event, which with no listener attached is an
   *  unhandled exception — i.e. journaling taking down the app, the one thing
   *  this module is not allowed to do. Synchronous means catchable. */
  complete(): void {
    try {
      writeFileSync(donePath(this.id), '', 'utf8')
    } catch (err) {
      console.error('[call-journal] could not mark complete:', err)
    }
  }

  /** Close without marking complete — the journal stays a recovery candidate.
   *  Nothing to release now that writes go straight through; kept as the
   *  explicit counterpart to complete() so call sites read symmetrically. */
  close(): void {
    /* no handle is held open */
  }
}

export interface OrphanJournal {
  id: string
  startedAt: string
  events: JournalEvent[]
  /** True when the last line was unreadable — the file was being written at
   *  the instant the process died. The events BEFORE it are still good. */
  truncated: boolean
}

/**
 * Read one journal back.
 *
 * Tolerant of a torn last line by design: the crash we are recovering from is
 * precisely the thing most likely to have interrupted a write mid-line. A
 * single unparseable trailing line costs the last utterance, not the call —
 * the same reasoning as jobs/store.ts tolerating a corrupt file rather than
 * crashing startup, one step less destructive because here we keep the good
 * prefix instead of discarding everything.
 */
export async function readJournal(id: string): Promise<OrphanJournal | null> {
  let raw: string
  try {
    raw = await readFile(journalPath(id), 'utf8')
  } catch {
    return null
  }
  const lines = raw.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return null

  let header: JournalHeader
  try {
    header = JSON.parse(lines[0]) as JournalHeader
  } catch {
    return null // no readable header — nothing trustworthy to recover
  }
  if (header.v !== 1 || typeof header.startedAt !== 'string') return null

  const events: JournalEvent[] = []
  let truncated = false
  for (let i = 1; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]) as JournalEvent)
    } catch {
      // Only the FINAL line may legitimately be torn. A bad line in the
      // middle means something worse than an interrupted write, so stop
      // rather than silently stitching across a hole.
      truncated = true
      break
    }
  }
  return { id, startedAt: header.startedAt, events, truncated }
}

/**
 * Every journal that represents a call which was never saved.
 *
 * CONSERVATIVE BY DESIGN: this only reports. It never creates a Call record
 * and never deletes a journal, because both failure modes are silent and
 * unrecoverable in opposite directions — a phantom call the rep did not have,
 * or a real call quietly thrown away. The decision belongs to the rep.
 */
export async function listOrphanJournals(): Promise<OrphanJournal[]> {
  let entries: string[]
  try {
    entries = await readdir(journalsDir())
  } catch {
    return [] // no journals directory yet — nothing to recover, not an error
  }
  const done = new Set(
    entries.filter((f) => f.endsWith('.done')).map((f) => f.slice(0, -'.done'.length))
  )
  const ids = entries
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .filter((id) => !done.has(id))

  const out: OrphanJournal[] = []
  for (const id of ids) {
    const journal = await readJournal(id)
    // A journal with a header but no events is a call where nothing was ever
    // said. Offering to "recover" it would produce an empty call record —
    // exactly the phantom this function exists to avoid.
    if (journal && journal.events.length > 0) out.push(journal)
  }
  // Oldest first, so the rep works through them in the order they happened.
  // The id tiebreak is not decoration: two journals stamped in the same
  // millisecond would otherwise fall back to readdir order, which is arbitrary
  // and would make the prompt list reshuffle between launches.
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
}

export interface ReplayedCall {
  startedAt: string
  durationMs: number
  segments: AccumulatedSegment[]
  /** The last consent state recorded during the call, or null if none ever
   *  was — which correctly means "no buyer-capture grant", the safe default. */
  consent: ConsentRecord | null
  truncated: boolean
}

/**
 * Rebuild a call's transcript from its journal.
 *
 * Replay is EXACT rather than approximate because TranscriptAccumulator is a
 * pure reducer — no clock, no randomness, no I/O — so feeding it the same
 * events in the same order yields the same transcript the live call had. That
 * property is what the 4.1 equivalence test exists to protect; if someone
 * makes the accumulator depend on wall-clock time, recovery quietly starts
 * producing something subtly different and this comment is the warning.
 */
export function replayJournal(journal: OrphanJournal): ReplayedCall {
  const acc = new TranscriptAccumulator()
  let consent: ConsentRecord | null = null
  let lastAt = 0
  for (const e of journal.events) {
    if (typeof e?.at === 'number' && Number.isFinite(e.at)) lastAt = Math.max(lastAt, e.at)
    switch (e?.t) {
      case 'result':
        acc.ingest(e.p)
        break
      case 'gap':
        acc.ingestGap(e.marker)
        break
      case 'boundary':
        acc.markSpeakerBoundary()
        break
      case 'rep':
        acc.identifyRep(e.epoch, e.speaker)
        break
      case 'consent':
        consent = e.c
        break
      default:
        // An event kind written by a NEWER version of the app. Skipping it
        // keeps recovery working on a downgrade instead of throwing away a
        // real call over a field this build does not understand.
        break
    }
  }
  return {
    startedAt: journal.startedAt,
    durationMs: Math.max(0, Math.round(lastAt)),
    segments: acc.snapshot(),
    consent,
    truncated: journal.truncated
  }
}

/** Remove a journal once the rep has decided about it (recovered or declined).
 *  Renames rather than unlinks on failure paths elsewhere; here the decision
 *  is explicit, so deletion is what was asked for. */
export async function discardJournal(id: string): Promise<void> {
  await unlink(journalPath(id)).catch(() => {})
  await unlink(donePath(id)).catch(() => {})
}

/** Retire a journal that has been recovered into a real Call, keeping the file
 *  under a `.recovered` name rather than deleting it. Cheap insurance: if the
 *  recovery itself produced something wrong, the source is still there. */
export async function retireJournal(id: string): Promise<void> {
  await rename(journalPath(id), recoveredPath(id)).catch(() => {})
  await unlink(donePath(id)).catch(() => {})
}

/**
 * 1.2.5 hotfix (privacy) — a normal successful save only ever marked the
 * journal `.done`; it never touched the buyer-attributed words already
 * written into it, so a call where the buyer never consented (or consent was
 * revoked mid-call) still had every one of the buyer's words sitting in
 * plaintext on disk forever — even though `applyConsentRetention`
 * (calls-fs.ts) already correctly strips that same content from the SAVED
 * CALL RECORD. This closes that gap on the raw journal file itself.
 *
 * Redaction happens at CLOSE time, not write time and not a periodic sweep:
 * consent isn't final until the call ends (it can be revoked or granted
 * mid-call), so redacting as events are written would mean guessing an
 * outcome that hasn't happened yet — and wouldn't even shrink real exposure,
 * since the case that matters most (a still-active call) is inherently still
 * open regardless. Consent is determined the exact same way `replayJournal`
 * already does: the LAST `consent` event in the file wins, matching
 * `applyConsentRetention` keying on the final `recordOtherParty` flag rather
 * than the status history.
 *
 * IDEMPOTENT AND FAILURE-SAFE BY DESIGN, on purpose: this runs both right
 * after every future call closes (see live-transcript.ts's endCall and
 * live-transcript-ipc.ts's recoverCall) AND as a startup sweep over the
 * backlog of journals written before this fix existed
 * (redactPendingClosedJournals, below). A `.redacted` marker is written ONLY
 * after a redaction attempt fully succeeds — never before, never on failure
 * — so a journal already processed is skipped instantly (cheap on every
 * launch), and a journal whose processing is interrupted (crash, force-quit,
 * locked file, corrupt line) is silently left unmarked and retried next time
 * rather than the whole sweep aborting or a partially-redacted / falsely-
 * marked journal being left behind.
 */
export async function redactJournalConsentIfNeeded(id: string): Promise<void> {
  try {
    await readFile(redactedMarkerPath(id), 'utf8')
    return // already processed
  } catch {
    /* not yet processed — continue */
  }

  // The file may still be at its original name (redacting right after a
  // normal save) or already renamed by retireJournal (redacting after a
  // crash-recovery decision) — check both rather than assuming an order.
  let path = journalPath(id)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    path = recoveredPath(id)
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      return // discarded, or never existed — nothing to redact, nothing to mark
    }
  }

  try {
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    if (lines.length === 0) {
      await writeFile(redactedMarkerPath(id), '', 'utf8')
      return
    }

    let header: JournalHeader
    try {
      header = JSON.parse(lines[0]) as JournalHeader
    } catch {
      return // unreadable header — same caution as readJournal: nothing trustworthy, retry later
    }

    const parsed: Array<JournalHeader | JournalEvent> = [header]
    let consent: ConsentRecord | null = null
    for (let i = 1; i < lines.length; i++) {
      let event: JournalEvent
      try {
        event = JSON.parse(lines[i]) as JournalEvent
      } catch {
        // A torn last line (the same tolerance readJournal applies) — stop
        // here rather than guessing at a broken line. Everything good before
        // it still gets redacted and marked; nothing is lost by stopping.
        break
      }
      if (event.t === 'consent') consent = event.c
      parsed.push(event)
    }

    if (!consent || consent.recordOtherParty !== true) {
      for (const event of parsed) {
        if ('t' in event && event.t === 'result') {
          const kept = event.p.words.filter((w) => !isOtherPartySpeaker(w.speaker, w.channel))
          if (kept.length !== event.p.words.length) {
            event.p.words = kept
            event.p.transcript = kept.map((w) => w.text).join(' ')
          }
        }
      }
      const tmpPath = `${path}.redact-tmp`
      await writeFile(tmpPath, `${parsed.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')
      await rename(tmpPath, path) // atomic — never leaves a half-written journal on disk
    }

    await writeFile(redactedMarkerPath(id), '', 'utf8')
  } catch (err) {
    // Deliberately no marker written: a failure here (locked file, disk
    // full, an error partway through) must leave the journal exactly as
    // findable and retryable next time as if this function had never run.
    console.error('[call-journal] consent redaction failed, will retry later:', id, err)
  }
}

/**
 * 1.2.5 hotfix — the backlog sweep for journals closed before this fix
 * shipped (every `.done` or `.recovered` journal from 1.2.0-1.2.4), plus a
 * safety net for any future one whose close-time redaction call didn't get
 * to run (app killed in the gap). Cheap and safe to call on every launch:
 * anything already `.redacted` is skipped via one failed readFile, and one
 * journal failing never stops the rest — see redactJournalConsentIfNeeded's
 * own per-item failure handling.
 *
 * Deliberately does NOT touch a journal still awaiting a recover/discard
 * decision (no `.done`, no `.recovered`) — that one is left to the normal
 * close path once the rep decides, so this sweep can never touch a journal
 * the interrupted-call recovery prompt is actively showing.
 */
export async function redactPendingClosedJournals(): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(journalsDir())
  } catch {
    return // no journals directory yet
  }
  const ids = new Set<string>()
  for (const f of entries) {
    if (f.endsWith('.done')) ids.add(f.slice(0, -'.done'.length))
    else if (f.endsWith('.jsonl.recovered')) ids.add(f.slice(0, -'.jsonl.recovered'.length))
  }
  for (const id of ids) {
    await redactJournalConsentIfNeeded(id)
  }
}
