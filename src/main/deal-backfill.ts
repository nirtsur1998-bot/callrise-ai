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
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
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
}

export interface BackfillState {
  rows: BackfillRow[]
  answered: number
  total: number
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
  try {
    const raw = await readFile(backfillFile(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return []
    const answers = (parsed as BackfillFile).answers
    if (!Array.isArray(answers)) return []
    return answers.filter(
      (a): a is BackfillAnswerRecord =>
        !!a &&
        typeof a === 'object' &&
        typeof (a as BackfillAnswerRecord).contactId === 'string' &&
        isAnswer((a as BackfillAnswerRecord).answer)
    )
  } catch {
    return [] // no file yet — not an error
  }
}

async function writeAnswers(answers: BackfillAnswerRecord[]): Promise<void> {
  const dir = app.getPath('userData')
  await mkdir(dir, { recursive: true })
  const file = backfillFile()
  const body: BackfillFile = { version: 1, answers }
  // Write-then-rename: a half-written answers file would read as "nothing was
  // ever answered" and silently re-open all 19 rows.
  await writeFile(file + '.tmp', JSON.stringify(body, null, 2), 'utf8')
  await rename(file + '.tmp', file)
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

export async function buildState(): Promise<BackfillState> {
  const [calls, contacts, deals, answers, stages] = await Promise.all([
    listCalls(callsDir()),
    listContacts(contactsDir()),
    listDeals(dealsDir()),
    readAnswers(),
    loadDealStages()
  ])

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
      dealId: recorded?.dealId
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

  const existing = await readAnswers()
  // Re-answering: undo the previous one first so a Won→Lost correction does
  // not leave the Won deal behind. Nineteen rows in one sitting means at
  // least one misclick, and a correction that silently doubles the sample is
  // worse than the misclick.
  const prior = existing.find((a) => a.contactId === contactId)
  if (prior) await undoRecord(prior)

  const kind = OUTCOME_ANSWER_KINDS[answer]
  const record: BackfillAnswerRecord = {
    contactId,
    answer,
    at: new Date().toISOString()
  }

  if (kind) {
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

    const deal = await createDeal(dealsDir(), {
      title: contact.company || contact.name,
      contactId,
      stageId: stage.id,
      notes: 'Recorded from past calls.'
    })
    if (!deal) return { ok: false, error: 'deal-failed' }

    const toLink = calls.filter((c) => c.contactId === contactId && c.hasCoaching && !c.dealId)
    for (const call of toLink) {
      await setCallDeal(callsDir(), call.id, deal.id)
    }
    record.dealId = deal.id
    record.linkedCallIds = toLink.map((c) => c.id)
  }

  await writeAnswers([...existing.filter((a) => a.contactId !== contactId), record])
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
  const existing = await readAnswers()
  const prior = existing.find((a) => a.contactId === contactId)
  if (prior) await undoRecord(prior)
  await writeAnswers(existing.filter((a) => a.contactId !== contactId))
  return { ok: true, state: await buildState() }
}

export function registerDealBackfill(): void {
  ipcMain.handle('dealBackfill:state', () => buildState())
  ipcMain.handle('dealBackfill:insight', () => computeInsight())
  ipcMain.handle('dealBackfill:answer', (_e, contactId: unknown, answer: unknown) =>
    recordAnswer(contactId, answer)
  )
  ipcMain.handle('dealBackfill:clear', (_e, contactId: unknown) => clearAnswer(contactId))
}
