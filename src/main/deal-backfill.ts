// M32 Stage 2 — the backfill: the one sitting where the founder tells the app
// how 19 past conversations actually ended.
//
// ── WHY A BACKFILL AT ALL ────────────────────────────────────────────────
//
// Outcome tracking needs closed deals to compare. The founder has four, all
// won, and the gate needs 8 in each arm. Waiting for that to accumulate
// naturally is months. The history already exists — 52 coached calls with
// nothing recording how they ended — so the fastest honest path is to ask.
//
// ── WHY IT IS LIST-DRIVEN AND NOT A PROMPT ───────────────────────────────
//
// The tempting design is a nudge: "how did the call with X end?" one at a
// time, whenever the app feels like asking. That produces a MEMORABLE sample,
// not a representative one — the deals recalled first are the dramatic ones,
// and dramatic correlates with outcome. The whole list is shown up front,
// every row at once, precisely so that answering row 14 is as likely as
// answering row 1.
//
// ── WHY LINKING HAPPENS HERE ─────────────────────────────────────────────
//
// An answer that creates a deal and links nothing is a no-op for the gate:
// `hasMetricCall` stays false, the deal is unusable, and 19 rows of the
// founder's time produce zero comparable samples. So an outcome answer links
// that contact's coached calls to the deal it creates. This is NOT inference —
// the contact had no deal before the answer, so the mapping is 1:1 at the
// moment it is recorded, the row states the count before it is clicked, and
// `linkedCallIds` records exactly what was touched so undo can put it back.
import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, rename } from 'node:fs/promises'
import { writeJsonAtomic } from './atomic-write'
import { scheduleBackup } from './backup'
import { listCalls, setCallDeal, type CallSummary } from './calls-fs'
import { listContacts } from './contacts-fs'
import { listDeals, createDeal, deleteDeal } from './deals-fs'
import { loadDealStages, type DealStageKind } from './deal-stages'
import {
  countAnswers,
  evaluateGate,
  type BackfillAnswer,
  type Insight,
  type OutcomeSample
} from './deal-outcomes'

/** Which stage kind each answer produces — and, for the two that produce
 *  none, an explicit null rather than an absent key. A `Record` over the full
 *  union so a sixth answer cannot be added without deciding this. */
const OUTCOME_ANSWER_KINDS: Record<BackfillAnswer, DealStageKind | null> = {
  won: 'won',
  lost: 'lost',
  'went-quiet': 'went-quiet',
  'dont-remember': null,
  'not-a-deal': null
}

export interface BackfillAnswerRecord {
  contactId: string
  answer: BackfillAnswer
  at: string
  /** The deal this answer created, if it created one. */
  dealId?: string
  /** Exactly the calls this answer linked — so undo unlinks THESE and not
   *  whatever happens to point at the deal later. */
  linkedCallIds?: string[]
  /** BUG-184 — not read from the answers file: rebuilt from the deal this
   *  answer created (see reconstructAnswers). Never written back to the file. */
  reconstructed?: boolean
}

/** One row of the sitting. Everything needed to answer it is here: the
 *  founder must never have to open a call to remember who this was, because
 *  that round-trip is the difference between finishing and abandoning. */
export interface BackfillRow {
  contactId: string
  name: string
  company?: string
  /** Coached calls with this contact — the ones that carry metrics. */
  callCount: number
  lastCallAt?: string
  /** The most recent call's title, as a memory jog. */
  lastCallTitle?: string
  answer?: BackfillAnswer
  dealId?: string
  /** How many calls the answer ACTUALLY linked — not the row's call total.
   *  The two differ when a call was already linked elsewhere or a write
   *  failed, and the row's confirmation line must report the real number. */
  linkedCallCount?: number
  /** BUG-184 — the answer record was missing and this row was rebuilt from
   *  the deal; the dialog says so, and ✕ still works. */
  reconstructed?: boolean
}

export interface BackfillState {
  rows: BackfillRow[]
  answered: number
  total: number
  /** Contacts with at least one coached call, BEFORE the has-a-deal exclusion
   *  — so an empty list can say which of its two causes applies (species 62:
   *  "everyone's covered" and "nothing is linked yet" need opposite actions). */
  coachedContactTotal: number
  insight: Insight
}

interface BackfillFile {
  version: 1
  answers: BackfillAnswerRecord[]
}

function backfillFile(): string {
  return join(app.getPath('userData'), 'deal-backfill.json')
}
function dealsDir(): string {
  return join(app.getPath('userData'), 'deals')
}
function callsDir(): string {
  return join(app.getPath('userData'), 'calls')
}
function contactsDir(): string {
  return join(app.getPath('userData'), 'contacts')
}

function isAnswer(v: unknown): v is BackfillAnswer {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(OUTCOME_ANSWER_KINDS, v)
}

export async function readAnswers(): Promise<BackfillAnswerRecord[]> {
  // ONLY a missing file means "no answers yet". The first version caught
  // everything — so a locked file (EBUSY from an AV scanner) or a corrupt one
  // read as an empty history, and the very next write then REPLACED the real
  // file with a one-record array, permanently discarding every prior record
  // and all of their undo metadata. Workflow finding, confirmed: the
  // catch-all converted a transient read error into silent total data loss.
  let raw: string
  try {
    raw = await readFile(backfillFile(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e // EBUSY/EPERM/etc: fail the operation loudly rather than clobber
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    const answers = (parsed as BackfillFile).answers
    if (!Array.isArray(answers)) throw new Error('answers is not an array')
    return answers.filter(
      (a): a is BackfillAnswerRecord =>
        !!a &&
        typeof a === 'object' &&
        typeof (a as BackfillAnswerRecord).contactId === 'string' &&
        isAnswer((a as BackfillAnswerRecord).answer)
    )
  } catch {
    // Corrupt content: move the evidence ASIDE instead of leaving it to be
    // overwritten — the records are unrecoverable by code but not by a human
    // reading the file. Then, and only then, treat the history as empty.
    const aside = backfillFile() + '.corrupt-' + Date.now()
    try {
      await rename(backfillFile(), aside)
      console.error('[deal-backfill] answers file was corrupt; preserved at ' + aside)
    } catch {
      /* if even the rename fails, the next write's tmp+rename replaces it */
    }
    return []
  }
}

async function writeAnswers(answers: BackfillAnswerRecord[]): Promise<void> {
  const dir = app.getPath('userData')
  await mkdir(dir, { recursive: true })
  const body: BackfillFile = { version: 1, answers }
  // The repo's atomic writer, not a hand-rolled tmp+rename: unique temp name
  // (two writers cannot clobber each other's temp), verify-parse before the
  // rename, and an fsync so a crash cannot publish an empty file — the exact
  // hazards atomic-write.ts's own header names, found sitting beside it.
  await writeJsonAtomic(backfillFile(), body)
}

// ── The write lock ─────────────────────────────────────────────────────────
// recordAnswer and clearAnswer are read-modify-write over ONE file, and the
// dialog deliberately keeps every row clickable while a save is in flight
// (its rule 6). Unserialized, two overlapping answers each read the same
// array and the last write silently dropped the other's record — while its
// deal and call links persisted, orphaned and invisible to undo. Same idiom
// as calls-fs's withCallLock, which exists for exactly this bug class; one
// global chain (not per-contact) because the file is global.
let backfillChain: Promise<unknown> = Promise.resolve()

function withBackfillLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = backfillChain.then(fn, fn)
  backfillChain = result.then(
    () => {},
    () => {}
  )
  return result
}

/** Coached calls, grouped by the contact they are linked to. Calls with no
 *  contact are excluded here rather than guessed at — 96 of 163 calls on the
 *  founder's machine have no contact, and attaching them by name similarity
 *  would put unattributable audio into a deal's evidence. */
function coachedByContact(calls: CallSummary[]): Map<string, CallSummary[]> {
  const byContact = new Map<string, CallSummary[]>()
  for (const c of calls) {
    if (!c.contactId || !c.hasCoaching) continue
    const list = byContact.get(c.contactId)
    if (list) list.push(c)
    else byContact.set(c.contactId, [c])
  }
  for (const list of byContact.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  return byContact
}

/** The note every backfill-created deal carries. For deals written before
 *  `origin` existed it is the only provenance they have, so it doubles as the
 *  legacy recogniser below. */
const BACKFILL_NOTE = 'Recorded from past calls.'

const ANSWER_FOR_KIND: Partial<Record<DealStageKind, BackfillAnswer>> = {
  won: 'won',
  lost: 'lost',
  'went-quiet': 'went-quiet'
}

function isBackfillDeal(d: { origin?: string; notes?: string }): boolean {
  return d.origin === 'backfill' || d.notes === BACKFILL_NOTE
}

/**
 * BUG-184 — REBUILD WHAT THE ANSWERS FILE HAS FORGOTTEN.
 *
 * Deals ride the cloud backup; `deal-backfill.json` does not. So a restore (or
 * any loss of the file) brings a backfill-created deal back with no record of
 * why it exists — and that deal then sat on the founder's board as a real
 * Lost: excluded from the backfill list (the contact "already has a deal"),
 * unreachable by ✕, and counted as the only data point on that side. The M32
 * scope predicted exactly this and it materialised on 2026-09-01.
 *
 * Everything the record held is still derivable from the deal and its calls:
 * the contact, the answer (the stage's kind), the deal id, and the linked
 * calls (the ones pointing at it). Only `at` is approximated by the deal's
 * creation time. So rather than make the file load-bearing, the file is
 * treated as a cache of what the deals already say. A record that IS in the
 * file always wins; reconstruction only fills the gaps.
 *
 * A backfill deal moved by hand into an open stage is no longer an answer —
 * it is a deal now — and is deliberately not rebuilt.
 */
function reconstructAnswers(
  fileAnswers: readonly BackfillAnswerRecord[],
  deals: readonly { id: string; contactId: string; stageId: string; origin?: string; notes?: string }[],
  calls: readonly CallSummary[],
  stages: readonly { id: string; kind: DealStageKind }[]
): BackfillAnswerRecord[] {
  const known = new Set(fileAnswers.map((a) => a.contactId))
  const kindByStage = new Map(stages.map((s) => [s.id, s.kind]))
  const rebuilt: BackfillAnswerRecord[] = []
  for (const d of deals) {
    if (known.has(d.contactId) || !isBackfillDeal(d)) continue
    const answer = ANSWER_FOR_KIND[kindByStage.get(d.stageId) ?? 'open']
    if (!answer) continue
    rebuilt.push({
      contactId: d.contactId,
      answer,
      at: (d as { createdAt?: string }).createdAt ?? new Date(0).toISOString(),
      dealId: d.id,
      linkedCallIds: calls.filter((c) => c.dealId === d.id).map((c) => c.id),
      reconstructed: true
    })
    known.add(d.contactId)
  }
  return rebuilt
}

/** The answers file plus whatever the deals can vouch for that it cannot.
 *  `file` is what may be written back; `all` is what the sitting shows. */
async function loadAnswers(): Promise<{
  file: BackfillAnswerRecord[]
  all: BackfillAnswerRecord[]
}> {
  const [file, deals, calls, stages] = await Promise.all([
    readAnswers(),
    listDeals(dealsDir()),
    listCalls(callsDir()),
    loadDealStages()
  ])
  return { file, all: [...file, ...reconstructAnswers(file, deals, calls, stages)] }
}

export async function buildState(): Promise<BackfillState> {
  const [calls, contacts, deals, fileAnswers, stages] = await Promise.all([
    listCalls(callsDir()),
    listContacts(contactsDir()),
    listDeals(dealsDir()),
    readAnswers(),
    loadDealStages()
  ])
  const answers = [...fileAnswers, ...reconstructAnswers(fileAnswers, deals, calls, stages)]

  const byContact = coachedByContact(calls)
  const contactById = new Map(contacts.map((c) => [c.id, c]))
  const answerByContact = new Map(answers.map((a) => [a.contactId, a]))
  // A contact that already has a deal is not a backfill candidate: the deal
  // already carries the outcome, and offering the row again would let one
  // contact contribute twice to the same arm. Rows this backfill itself
  // created are the exception — they must stay visible to be undoable.
  const contactsWithDeals = new Set(deals.map((d) => d.contactId))

  const rows: BackfillRow[] = []
  for (const [contactId, contactCalls] of byContact) {
    const recorded = answerByContact.get(contactId)
    if (contactsWithDeals.has(contactId) && !recorded?.dealId) continue
    const contact = contactById.get(contactId)
    if (!contact) continue
    rows.push({
      contactId,
      name: contact.name,
      company: contact.company || undefined,
      callCount: contactCalls.length,
      lastCallAt: contactCalls[0]?.createdAt,
      lastCallTitle: contactCalls[0]?.title,
      answer: recorded?.answer,
      dealId: recorded?.dealId,
      linkedCallCount: recorded?.linkedCallIds?.length,
      reconstructed: recorded?.reconstructed
    })
  }

  // STABLE ORDER, AND NOT BY ANSWERED-NESS. Sorting answered rows to the
  // bottom would move the row under the founder's cursor on every single
  // click — nineteen times. Most recent first, and it never changes while the
  // sitting is open.
  rows.sort((a, b) => (b.lastCallAt ?? '').localeCompare(a.lastCallAt ?? ''))

  return {
    rows,
    answered: rows.filter((r) => r.answer).length,
    total: rows.length,
    coachedContactTotal: byContact.size,
    insight: gateFrom(calls, deals, stages, answers, rows.length)
  }
}

/** The gate, from data already in hand. Pure apart from its inputs, so the
 *  two callers below cannot compute it two different ways. */
function gateFrom(
  calls: CallSummary[],
  deals: { id: string; stageId: string }[],
  stages: { id: string; kind: DealStageKind }[],
  answers: BackfillAnswerRecord[],
  listSize: number
): Insight {
  const kindByStage = new Map(stages.map((s) => [s.id, s.kind]))
  // A deal is measurable when at least one call linked TO IT carries coaching
  // metrics. Deliberately keyed on `call.dealId`, not on the contact: the
  // contact route is the ambiguous one this whole field exists to replace.
  const measurableDeals = new Set(
    calls.filter((c) => c.dealId && c.hasCoaching).map((c) => c.dealId as string)
  )
  const samples: OutcomeSample[] = deals.map((d) => ({
    dealId: d.id,
    kind: kindByStage.get(d.stageId) ?? 'open',
    hasMetricCall: measurableDeals.has(d.id)
  }))
  return evaluateGate(
    samples,
    countAnswers(
      answers.map((a) => a.answer),
      listSize
    )
  )
}

/** The gate alone — what the Pipeline counter reads. Goes through buildState
 *  rather than recomputing, so the counter and the backfill can never
 *  disagree about how many deals are usable. */
export async function computeInsight(): Promise<Insight> {
  return (await buildState()).insight
}

export interface AnswerResult {
  ok: boolean
  error?: 'unknown-contact' | 'no-stage-for-kind' | 'deal-failed'
  state?: BackfillState
}

/**
 * Record one answer. ONE CLICK, and everything it implies happens here:
 * for an outcome answer that means creating the deal and linking the calls
 * the row already told the founder about.
 */
export async function recordAnswer(contactId: unknown, answer: unknown): Promise<AnswerResult> {
  if (typeof contactId !== 'string' || !contactId || !isAnswer(answer)) {
    return { ok: false, error: 'unknown-contact' }
  }
  return withBackfillLock(() => recordAnswerLocked(contactId, answer as BackfillAnswer))
}

async function recordAnswerLocked(
  contactId: string,
  answer: BackfillAnswer
): Promise<AnswerResult> {
  // `all` includes answers rebuilt from orphaned backfill deals (BUG-184), so
  // a correction retires that deal exactly as it would a recorded one.
  const { file: existing, all } = await loadAnswers()
  const prior = all.find((a) => a.contactId === contactId)

  const kind = OUTCOME_ANSWER_KINDS[answer]
  const record: BackfillAnswerRecord = {
    contactId,
    answer,
    at: new Date().toISOString()
  }

  if (kind) {
    // ── VALIDATE AND BUILD BEFORE UNDOING ANYTHING ───────────────────────
    //
    // The first version undid the prior answer FIRST, then validated the new
    // one — so a Won-to-Lost correction in a pipeline whose Lost stage had
    // been deleted destroyed the Won deal (with any value/notes/reason the
    // founder had put on it), returned an error implying nothing changed, and
    // left the answers file pointing at a tombstone. Workflow finding,
    // confirmed. Nothing here may be torn down until its replacement exists.
    const [contacts, stages, calls] = await Promise.all([
      listContacts(contactsDir()),
      loadDealStages(),
      listCalls(callsDir())
    ])
    const contact = contacts.find((c) => c.id === contactId)
    if (!contact) return { ok: false, error: 'unknown-contact' }

    const stage = stages.find((s) => s.kind === kind)
    // A user who deleted their "Lost" stage cannot record a lost outcome, and
    // the honest answer is to say so rather than parking the deal in whatever
    // stage happens to be first.
    if (!stage) return { ok: false, error: 'no-stage-for-kind' }

    // Eligible calls include the ones the PRIOR answer linked — after the
    // undo below they are unlinked again, and a correction must carry them
    // to the corrected deal rather than stranding them.
    const priorDealId = prior?.dealId
    const toLink = calls.filter(
      (c) =>
        c.contactId === contactId &&
        c.hasCoaching &&
        (!c.dealId || (priorDealId !== undefined && c.dealId === priorDealId))
    )

    const deal = await createDeal(dealsDir(), {
      title: contact.company || contact.name,
      contactId,
      stageId: stage.id,
      notes: BACKFILL_NOTE,
      // BUG-184: the deal carries its own provenance, so it can be recognised
      // and undone even after the answers file is gone.
      origin: 'backfill'
    })
    if (!deal) return { ok: false, error: 'deal-failed' } // prior untouched

    // The replacement exists — NOW retire the prior answer's artifacts.
    if (prior) await undoRecord(prior)

    // Per-call try/catch so one failed write cannot leave the record lying
    // about the rest: linkedCallIds holds what was ACTUALLY linked.
    const linked: string[] = []
    for (const call of toLink) {
      try {
        const r = await setCallDeal(callsDir(), call.id, deal.id)
        if (r?.dealId === deal.id) linked.push(call.id)
      } catch {
        /* recorded by omission — the record carries only real links */
      }
    }
    record.dealId = deal.id
    record.linkedCallIds = linked
  } else if (prior) {
    // A non-outcome answer replacing an outcome one still needs the undo —
    // it just runs after the (trivial) validation above it has passed.
    await undoRecord(prior)
  }

  await writeAnswers([...existing.filter((a) => a.contactId !== contactId), record])
  // The answer may have created a deal and rewritten call records — the same
  // mutations every sibling IPC handler follows with a backup schedule.
  scheduleBackup()
  return { ok: true, state: await buildState() }
}

/** Put a row back exactly as it was: unlink the calls THIS answer linked, and
 *  delete the deal it created. Nothing else is touched. */
async function undoRecord(record: BackfillAnswerRecord): Promise<void> {
  for (const callId of record.linkedCallIds ?? []) {
    await setCallDeal(callsDir(), callId, null)
  }
  if (record.dealId) await deleteDeal(dealsDir(), record.dealId)
}

export async function clearAnswer(contactId: unknown): Promise<AnswerResult> {
  if (typeof contactId !== 'string' || !contactId) {
    return { ok: false, error: 'unknown-contact' }
  }
  return withBackfillLock(async () => {
    const { file: existing, all } = await loadAnswers()
    const prior = all.find((a) => a.contactId === contactId)
    if (prior) await undoRecord(prior)
    await writeAnswers(existing.filter((a) => a.contactId !== contactId))
    scheduleBackup()
    return { ok: true, state: await buildState() }
  })
}

// ── M34 — LINK THE CALLS A CLOSED DEAL ALREADY HAS ────────────────────────
//
// The founder's board said "4 won" while the gate saw zero, because none of
// those deals had a coached call linked to it — the calls existed, on the
// right contacts, unlinked. Linking them by hand is twelve clicks across four
// pages, which is exactly the friction that means it never happens. This is
// the backfill's lesson applied to deals that already exist: show the WHOLE
// set up front with a count, and make each one (or all of them) one click.
//
// Records only. A call is offered for a deal when it already belongs to that
// deal's CONTACT, carries coaching metrics, and belongs to no deal yet. The
// deal must already be closed (the gate only counts closed deals) and have no
// coached call linked (otherwise it already counts). No stage changes, no
// guessing across contacts, nothing from the outcome gate.

export interface LinkSuggestion {
  dealId: string
  dealTitle: string
  contactId: string
  contactName: string
  stageLabel: string
  kind: DealStageKind
  /** The contact's coached calls that belong to no deal — what one click links. */
  coachedCallIds: string[]
}

export interface LinkSuggestions {
  deals: LinkSuggestion[]
  totalCalls: number
}

export interface LinkResult {
  ok: boolean
  /** Calls actually linked by this call — the real number, not the offer. */
  linked: number
  suggestions: LinkSuggestions
  state: BackfillState
}

export async function linkSuggestions(): Promise<LinkSuggestions> {
  const [calls, contacts, deals, stages] = await Promise.all([
    listCalls(callsDir()),
    listContacts(contactsDir()),
    listDeals(dealsDir()),
    loadDealStages()
  ])
  const stageById = new Map(stages.map((s) => [s.id, s]))
  const contactById = new Map(contacts.map((c) => [c.id, c]))
  // Same definition of "counts" as the gate: a coached call linked to the deal.
  const alreadyCounted = new Set(
    calls.filter((c) => c.dealId && c.hasCoaching).map((c) => c.dealId as string)
  )
  const out: LinkSuggestion[] = []
  for (const d of deals) {
    const stage = stageById.get(d.stageId)
    if (!stage || stage.kind === 'open') continue
    if (alreadyCounted.has(d.id)) continue
    const coachedCallIds = calls
      .filter((c) => c.contactId === d.contactId && c.hasCoaching && !c.dealId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((c) => c.id)
    if (coachedCallIds.length === 0) continue
    out.push({
      dealId: d.id,
      dealTitle: d.title,
      contactId: d.contactId,
      contactName: contactById.get(d.contactId)?.name ?? '',
      stageLabel: stage.label,
      kind: stage.kind,
      coachedCallIds
    })
  }
  return { deals: out, totalCalls: out.reduce((n, s) => n + s.coachedCallIds.length, 0) }
}

async function linkOne(s: LinkSuggestion): Promise<number> {
  let linked = 0
  for (const id of s.coachedCallIds) {
    try {
      const r = await setCallDeal(callsDir(), id, s.dealId)
      if (r?.dealId === s.dealId) linked++
    } catch {
      /* the count reports what actually linked */
    }
  }
  return linked
}

/** Link every offered call for ONE deal. Recomputes the offer first, so a
 *  stale dialog cannot link a call that was claimed by another deal meanwhile. */
export async function linkCoachedCalls(dealId: unknown): Promise<LinkResult> {
  const fail = async (): Promise<LinkResult> => ({
    ok: false,
    linked: 0,
    suggestions: await linkSuggestions(),
    state: await buildState()
  })
  if (typeof dealId !== 'string' || !dealId) return fail()
  const s = (await linkSuggestions()).deals.find((x) => x.dealId === dealId)
  if (!s) return fail()
  const linked = await linkOne(s)
  scheduleBackup()
  return { ok: true, linked, suggestions: await linkSuggestions(), state: await buildState() }
}

/** Link every offered call for EVERY deal in the set — the "show me the whole
 *  set up front" click. Sequential, so two deals can never race for a call. */
export async function linkAllSuggested(): Promise<LinkResult> {
  const { deals } = await linkSuggestions()
  let linked = 0
  for (const s of deals) linked += await linkOne(s)
  if (linked > 0) scheduleBackup()
  return { ok: true, linked, suggestions: await linkSuggestions(), state: await buildState() }
}

export function registerDealBackfill(): void {
  ipcMain.handle('dealBackfill:state', () => buildState())
  ipcMain.handle('dealBackfill:insight', () => computeInsight())
  ipcMain.handle('dealBackfill:answer', (_e, contactId: unknown, answer: unknown) =>
    recordAnswer(contactId, answer)
  )
  ipcMain.handle('dealBackfill:clear', (_e, contactId: unknown) => clearAnswer(contactId))
  ipcMain.handle('dealBackfill:linkSuggestions', () => linkSuggestions())
  ipcMain.handle('dealBackfill:linkCoachedCalls', (_e, dealId: unknown) => linkCoachedCalls(dealId))
  ipcMain.handle('dealBackfill:linkAllSuggested', () => linkAllSuggested())
}
