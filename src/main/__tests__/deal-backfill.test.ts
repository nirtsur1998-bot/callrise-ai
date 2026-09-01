// The backfill's WRITE path, end to end, against a real temp profile.
//
// WHY THIS EXISTS RATHER THAN A UI PASS. Clicking "Won" on a row is not a
// setting — it creates a deal, rewrites call records to point at it, and can
// be undone. Verifying that by driving the founder's live app would mean
// mutating their real deals and calls in order to check that mutating them
// works. So the visible surface is verified in the app, and everything the
// click DOES is verified here, on a temp directory that is deleted afterwards.
//
// The specific failures being prevented, each of which is silent:
//
//  1. AN ANSWER THAT LINKS NOTHING. The deal exists, the counts look like they
//     moved, and `hasMetricCall` is false forever — so the gate can never open
//     and the counter never explains why. Nineteen rows of the founder's time
//     for zero usable samples.
//  2. A CORRECTION THAT DOUBLES THE SAMPLE. Won → Lost leaving the Won deal
//     behind means one contact in both arms. At a bar of 8 per arm, two
//     misclicks are a quarter of the evidence.
//  3. AN UNDO THAT UNLINKS SOMEONE ELSE'S CALLS. Clearing a row must put back
//     exactly what that answer touched, not everything currently pointing at
//     the deal.
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let USER_DATA = ''

vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getName: () => 'CallRise AI' },
  ipcMain: { handle: vi.fn() }
}))

const { saveCall, getCall, listCalls, setCallCoaching, setCallContact, setCallDeal } =
  await import('../calls-fs')
const { createContact } = await import('../contacts-fs')
const { listDeals } = await import('../deals-fs')
const { recordAnswer, clearAnswer, buildState, readAnswers } = await import('../deal-backfill')
const { setDealStages } = await import('../deal-stages')

const STAGES = [
  { id: 'st-open', label: 'Working', kind: 'open' as const },
  { id: 'st-won', label: 'Won', kind: 'won' as const },
  { id: 'st-lost', label: 'Lost', kind: 'lost' as const },
  { id: 'st-quiet', label: 'Went quiet', kind: 'went-quiet' as const }
]

async function seedContactWithCoachedCalls(name: string, n: number): Promise<string> {
  const contact = await createContact(join(USER_DATA, 'contacts'), { name } as never)
  const contactId = (contact as { id: string }).id
  for (let i = 0; i < n; i++) {
    const s = await saveCall(join(USER_DATA, 'calls'), {
      startedAt: new Date(Date.now() - i * 86_400_000).toISOString(),
      durationMs: 60_000,
      segments: [{ speaker: 0, text: 'hello', startMs: 0, endMs: 500 }]
    } as never)
    // `CallSaveInput` has no contactId — the link is a separate write. Passing
    // it to saveCall (the first draft did) is silently ignored, which is what
    // produced a candidate list of zero while the coaching seed was fine.
    const linked = await setCallContact(join(USER_DATA, 'calls'), (s as { id: string }).id, contactId)
    if (linked?.contactId !== contactId) throw new Error('fixture failed: contact link not saved')
    // A call only counts if it CARRIES METRICS, so seed coaching explicitly.
    //
    // ALL SIX DIMENSIONS, because `sanitizeCoaching` returns null unless every
    // one is present — and setCallCoaching then saves NOTHING. The first draft
    // of this helper passed a plausible-looking report with an empty
    // `dimensions` array and no `overallScore`; every call came back uncoached,
    // the candidate list was empty, and four tests failed at once. They failed
    // in the right order: the control below runs first and said "the seed
    // produced no backfill rows" instead of letting three assertions about
    // linking pass vacuously against zero rows.
    const coached = await setCallCoaching(join(USER_DATA, 'calls'), (s as { id: string }).id, {
      overallScore: 70,
      dealContext: {},
      strength: { text: 'clear framing' },
      dimensions: ['discovery', 'engagement', 'objection', 'value', 'nextStep', 'control'].map(
        (key) => ({ key, score: 4, comment: 'ok' })
      ),
      improvements: [],
      nextAction: 'follow up',
      metrics: {},
      model: 'test',
      createdAt: new Date().toISOString()
    } as never)
    // The fixture checks its own write. A seeder that silently fails is how
    // every test downstream of it becomes a test of nothing.
    if (!coached?.coaching) throw new Error('fixture failed: setCallCoaching saved nothing')
  }
  return contactId
}

describe('the backfill write path', () => {
  beforeEach(async () => {
    USER_DATA = await mkdtemp(join(tmpdir(), 'callrise-backfill-'))
    expect(setDealStages(STAGES).ok, 'stage seed failed').toBe(true)
  })
  afterEach(async () => {
    await rm(USER_DATA, { recursive: true, force: true })
  })

  it('the fixture really produces answerable rows', async () => {
    // THE CONTROL, and it goes first. Every test below asserts something about
    // a row; if the seed produced no coached calls there would be no rows, and
    // "no deals were created" would pass for the wrong reason in each one.
    await seedContactWithCoachedCalls('Ada', 2)
    const state = await buildState()
    expect(state.total, 'the seed produced no backfill rows').toBe(1)
    expect(state.rows[0].callCount).toBe(2)
    expect(state.answered).toBe(0)
  })

  it('an outcome answer creates a deal AND links the calls', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 2)
    const result = await recordAnswer(contactId, 'lost')
    expect(result.ok).toBe(true)

    const deals = await listDeals(join(USER_DATA, 'deals'))
    expect(deals, 'no deal was created for a lost answer').toHaveLength(1)
    expect(deals[0].stageId).toBe('st-lost')

    const calls = await listCalls(join(USER_DATA, 'calls'))
    expect(
      calls.map((c) => c.dealId),
      'the answer created a deal but linked no calls — the gate could never open'
    ).toEqual([deals[0].id, deals[0].id])
  })

  it('the gate counts that deal as USABLE, not merely as present', async () => {
    // The join actually working, observed through the gate rather than through
    // the file that was just written.
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    await recordAnswer(contactId, 'won')
    const { insight } = await buildState()
    if (insight.status !== 'insufficient') throw new Error('unreachable at N=1')
    expect(insight.usable.won).toBe(1)
  })

  it('"I don\'t remember" records the answer and creates NO deal', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    await recordAnswer(contactId, 'dont-remember')
    expect(await listDeals(join(USER_DATA, 'deals'))).toHaveLength(0)
    const answers = await readAnswers()
    expect(answers, 'the answer was not recorded, so the row would reappear').toHaveLength(1)
    expect(answers[0].answer).toBe('dont-remember')
    expect(answers[0].dealId).toBeUndefined()
  })

  it('correcting Won → Lost leaves exactly ONE deal, in the new stage', async () => {
    // Failure 2. Nineteen rows in one sitting guarantees a misclick; a
    // correction that leaves the first deal behind puts one contact in both
    // arms of a comparison whose bar is eight per arm.
    const contactId = await seedContactWithCoachedCalls('Ada', 2)
    await recordAnswer(contactId, 'won')
    await recordAnswer(contactId, 'lost')

    const deals = await listDeals(join(USER_DATA, 'deals'))
    expect(deals, 'the corrected answer left the old deal behind').toHaveLength(1)
    expect(deals[0].stageId).toBe('st-lost')

    const calls = await listCalls(join(USER_DATA, 'calls'))
    expect(new Set(calls.map((c) => c.dealId)), 'calls still point at the deleted deal').toEqual(
      new Set([deals[0].id])
    )
  })

  it('clearing a row removes the deal and unlinks the calls', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 2)
    await recordAnswer(contactId, 'won')
    await clearAnswer(contactId)

    expect(await listDeals(join(USER_DATA, 'deals'))).toHaveLength(0)
    const calls = await listCalls(join(USER_DATA, 'calls'))
    expect(
      calls.map((c) => c.dealId),
      'undo left calls pointing at a deal that no longer exists'
    ).toEqual([undefined, undefined])
    expect(await readAnswers()).toHaveLength(0)
  })

  it('undo only touches the calls THAT answer linked', async () => {
    // Failure 3. A second contact's call is linked to the same deal by hand
    // afterwards; clearing the first row must not unlink it.
    const adaId = await seedContactWithCoachedCalls('Ada', 1)
    await seedContactWithCoachedCalls('Grace', 1)
    await recordAnswer(adaId, 'won')
    const deal = (await listDeals(join(USER_DATA, 'deals')))[0]

    const graceCall = (await listCalls(join(USER_DATA, 'calls'))).find((c) => !c.dealId)!
    await setCallDeal(join(USER_DATA, 'calls'), graceCall.id, deal.id)

    await clearAnswer(adaId)
    const after = await getCall(join(USER_DATA, 'calls'), graceCall.id)
    expect(
      after?.dealId,
      'undo unlinked a call it never linked — it swept the deal, not its own record'
    ).toBe(deal.id)
  })

  it('refuses an outcome whose stage kind does not exist in the pipeline', async () => {
    // A user who deleted their "Lost" column. Parking the deal in whatever
    // stage happens to be first would silently file a loss as a win.
    expect(setDealStages([STAGES[0], STAGES[1]]).ok, 'stage reseed failed').toBe(true)
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    const result = await recordAnswer(contactId, 'lost')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no-stage-for-kind')
    expect(await listDeals(join(USER_DATA, 'deals'))).toHaveLength(0)
  })

  it('a garbage answer is rejected and writes nothing', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    expect((await recordAnswer(contactId, 'maybe')).ok).toBe(false)
    expect((await recordAnswer('', 'won')).ok).toBe(false)
    expect(await listDeals(join(USER_DATA, 'deals'))).toHaveLength(0)
    expect(await readAnswers()).toHaveLength(0)
  })

  it('TWO CONCURRENT answers both survive — the file write is serialized', async () => {
    // WORKFLOW FINDING (confirmed, high): recordAnswer was an unlocked
    // read-modify-write of the whole answers file, and the dialog's rule 6
    // deliberately keeps every button live while a save is in flight. Two
    // overlapping answers each read the same array, each wrote it back, and
    // the last rename silently dropped the other contact's record — while its
    // deal and call links persisted, orphaned and unreachable by undo.
    const ada = await seedContactWithCoachedCalls('Ada', 1)
    const grace = await seedContactWithCoachedCalls('Grace', 1)
    const [r1, r2] = await Promise.all([recordAnswer(ada, 'won'), recordAnswer(grace, 'lost')])
    expect(r1.ok && r2.ok).toBe(true)
    const answers = await readAnswers()
    expect(
      answers.map((a) => a.contactId).sort(),
      'a concurrent answer was silently dropped from the file'
    ).toEqual([ada, grace].sort())
    expect(await listDeals(join(USER_DATA, 'deals'))).toHaveLength(2)
  })

  it('a concurrent DOUBLE-CLICK on one row yields exactly one deal, not two', async () => {
    // The same race on a single row: neither call saw the other as "prior",
    // so undo was skipped and createDeal ran twice — one contact contributing
    // two deals to the arms, the exact double-count the design says it
    // prevents.
    const ada = await seedContactWithCoachedCalls('Ada', 2)
    await Promise.all([recordAnswer(ada, 'won'), recordAnswer(ada, 'lost')])
    const deals = await listDeals(join(USER_DATA, 'deals'))
    expect(deals, 'a racing double-click minted two deals for one contact').toHaveLength(1)
    const answers = await readAnswers()
    expect(answers).toHaveLength(1)
    // Whichever answer won the race, the record and the deal must AGREE.
    expect(answers[0].dealId).toBe(deals[0].id)
  })

  it('a FAILED correction leaves the prior answer fully intact', async () => {
    // WORKFLOW FINDING (confirmed, high): the old order ran undoRecord(prior)
    // BEFORE validating the new answer. A Won -> Lost correction with no Lost
    // stage destroyed the Won deal — including any value/notes/reason typed
    // onto it — returned an error saying nothing was recorded, and left the
    // answers file still claiming the Won deal existed. Validation now runs
    // first; nothing is undone until the replacement can actually be built.
    const ada = await seedContactWithCoachedCalls('Ada', 2)
    await recordAnswer(ada, 'won')
    const dealBefore = (await listDeals(join(USER_DATA, 'deals')))[0]

    // Remove the Lost stage, making 'lost' unrecordable.
    expect(setDealStages([STAGES[0], STAGES[1]]).ok).toBe(true)

    const result = await recordAnswer(ada, 'lost')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no-stage-for-kind')

    const dealsAfter = await listDeals(join(USER_DATA, 'deals'))
    expect(dealsAfter, 'the failed correction destroyed the prior deal').toHaveLength(1)
    expect(dealsAfter[0].id).toBe(dealBefore.id)
    const calls = await listCalls(join(USER_DATA, 'calls'))
    expect(
      calls.map((c) => c.dealId),
      'the failed correction unlinked the prior calls'
    ).toEqual([dealBefore.id, dealBefore.id])
    const answers = await readAnswers()
    expect(answers).toHaveLength(1)
    expect(answers[0].answer).toBe('won')
    expect(answers[0].dealId).toBe(dealBefore.id)
  })

  it('measurability is keyed on call.dealId, NOT on the contact', async () => {
    // WORKFLOW FINDING (confirmed, medium): every fixture linked calls and
    // deal through the same contact, so a contact-keyed implementation — the
    // exact one gateFrom's comment forbids — would have passed every test.
    // This is the discriminating state: the coached call belongs to Ada, the
    // deal it is LINKED to belongs to Grace.
    const adaId = await seedContactWithCoachedCalls('Ada', 1)
    await seedContactWithCoachedCalls('Grace', 1)
    await recordAnswer(adaId, 'won') // Ada's deal, Ada's call linked

    // Grace's deal, created by answering — then re-link ADA's call to it.
    const graceRow = (await buildState()).rows.find((r) => r.name === 'Grace')!
    await recordAnswer(graceRow.contactId, 'lost')
    const deals = await listDeals(join(USER_DATA, 'deals'))
    const graceDeal = deals.find((d) => d.contactId === graceRow.contactId)!
    const adaCall = (await listCalls(join(USER_DATA, 'calls'))).find(
      (c) => c.contactId === adaId
    )!
    await setCallDeal(join(USER_DATA, 'calls'), adaCall.id, graceDeal.id)

    const { insight } = await buildState()
    if (insight.status !== 'insufficient') throw new Error('unreachable at N=2')
    // Ada's deal lost its only measurable call; Grace's deal gained one that
    // belongs to another contact. dealId-keyed: won=0, lost=1 (+ Grace's own
    // call still linked -> lost stays 1). Contact-keyed would report won=1.
    expect(insight.usable.won, 'a contact-keyed gate would count the unlinked deal').toBe(0)
    expect(insight.usable.lost).toBe(1)
  })

  it('the answers file survives a reload and is valid JSON on disk', async () => {
    const contactId = await seedContactWithCoachedCalls('Ada', 1)
    await recordAnswer(contactId, 'went-quiet')
    const raw = await readFile(join(USER_DATA, 'deal-backfill.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version: number; answers: unknown[] }
    expect(parsed.version).toBe(1)
    expect(parsed.answers).toHaveLength(1)
    // ...and no leftover temp artifacts — by ENUMERATING the directory, not
    // by probing one hardcoded name. The write path now uses writeJsonAtomic
    // (unique uuid-suffixed temps); a filename probe pinned to the old
    // '.tmp' scheme would pass vacuously forever against names that can no
    // longer exist. Absence tests enumerate the container.
    const leftovers = (await readdir(USER_DATA)).filter((f) => /\.tmp/.test(f))
    expect(leftovers, 'temp artifacts survived the atomic write').toEqual([])
  })
})
