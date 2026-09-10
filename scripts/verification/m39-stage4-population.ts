/**
 * M39 Stage 4 — measure the population of all four remaining features BEFORE
 * writing any of them.
 *
 * READ-ONLY. This is the check that saved the dossier's stakeholder section
 * from shipping as a permanently empty block, applied to the whole list. The
 * founder's own rule for Stage 4 was "one at a time, each measured", and the
 * accepted output shape for a feature that cannot be fed is a CUT with the
 * corpus size it would need.
 *
 * A zero below means one of two things and the point of each count is to say
 * which: the mechanism is missing, or the population is empty.
 *
 * usage: npx tsx --tsconfig tsconfig.node.json scripts/verification/m39-stage4-population.ts <profileDir>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = process.argv[2]
if (!PROFILE) {
  console.error('usage: m39-stage4-population.ts <profileDir>')
  process.exit(1)
}
function readAll<T>(dir: string): T[] {
  const p = join(PROFILE, dir)
  if (!existsSync(p)) return []
  return readdirSync(p)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(p, f), 'utf8')) as T]
      } catch {
        return []
      }
    })
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const calls = readAll<any>('calls').filter((c) => !c.deleted)
const contacts = readAll<any>('contacts')
const deals = readAll<any>('deals')
const tasks = readAll<any>('tasks')
const objections = readAll<any>('objection-queue')

const byContact = new Map<string, any[]>()
for (const c of calls) {
  if (!c.contactId) continue
  const a = byContact.get(c.contactId) ?? []
  a.push(c)
  byContact.set(c.contactId, a)
}
for (const [, list] of byContact) {
  list.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}
const multiCall = [...byContact.entries()].filter(([, l]) => l.length >= 2)

console.log(`corpus: ${calls.length} live calls, ${contacts.length} contacts, ${deals.length} deals, ${tasks.length} tasks, ${objections.length} mined objections`)
console.log(`contacts with 2+ calls (the floor for anything "since last time"): ${multiCall.length}`)
console.log('')

// --- #1 objection pre-loading ----------------------------------------------
// "She raised budget on the last two calls" needs a recurring objection TYPE,
// per contact, across calls. A free-text coaching comment cannot give a type
// without a pattern net, so the question is whether the mined objection queue
// carries one AND ties back to a call.
console.log('#1 OBJECTION PRE-LOADING — needs a recurring objection TYPE per contact')
const objKeys = new Set<string>()
for (const o of objections.slice(0, 50)) for (const k of Object.keys(o)) objKeys.add(k)
console.log(`  objection-queue records            : ${objections.length}`)
console.log(`  their fields                       : ${[...objKeys].join(', ') || '(none — the directory is empty)'}`)
const withCall = objections.filter((o) => o.callId).length
const typeField = ['type', 'category', 'kind', 'objectionType'].find((f) => objKeys.has(f))
console.log(`  carrying a callId                  : ${withCall}`)
console.log(`  carrying a type field              : ${typeField ?? 'NONE'}`)
if (typeField && withCall) {
  const callToContact = new Map(calls.map((c) => [c.id, c.contactId]))
  const perContact = new Map<string, Map<string, Set<string>>>()
  for (const o of objections) {
    const contactId = callToContact.get(o.callId)
    if (!contactId) continue
    const m = perContact.get(contactId) ?? new Map<string, Set<string>>()
    const s = m.get(String(o[typeField])) ?? new Set<string>()
    s.add(o.callId)
    m.set(String(o[typeField]), s)
    perContact.set(contactId, m)
  }
  const recurring = [...perContact.entries()].filter(([, m]) => [...m.values()].some((s) => s.size >= 2))
  console.log(`  >> contacts with the SAME objection type on 2+ calls : ${recurring.length} of ${contacts.length}`)
  for (const [id, m] of recurring.slice(0, 6)) {
    const name = contacts.find((c) => c.id === id)?.name ?? id.slice(0, 8)
    const types = [...m.entries()].filter(([, s]) => s.size >= 2).map(([t, s]) => `${t}×${s.size}`)
    console.log(`       ${name}: ${types.join(', ')}`)
  }
} else {
  console.log('  >> CANNOT BE COMPUTED from records: no typed objection tied to a call.')
}
console.log('')

// --- #4 commitment tracking -------------------------------------------------
// "You said you'd send the security doc on the 3rd. You haven't." The "haven't"
// half needs a DUE DATE and a check. The reverse half needs promises made BY
// the buyer, which nothing extracts today.
console.log('#4 COMMITMENT TRACKING — needs a promise, a date, and a check')
const taskKeys = new Set<string>()
for (const t of tasks) for (const k of Object.keys(t)) taskKeys.add(k)
// `status`/`completedAt`, NOT `done`. This script's first version read `!t.done`
// and reported "28 open" for a store where 24 are complete — and the feature
// code it was measuring made the same wrong assumption, so the two agreed with
// each other instead of with the records. Independently-wrong agreement: two
// checks are only two checks when they can disagree.
const isDone = (t: any): boolean =>
  t.done === true || t.status === 'done' || t.status === 'completed' || !!t.completedAt
console.log(`  tasks                              : ${tasks.length} (${tasks.filter((t) => !isDone(t)).length} open, ${tasks.filter(isDone).length} done)`)
console.log(`  their fields                       : ${[...taskKeys].join(', ')}`)
const dueField = ['dueAt', 'dueDate', 'due'].find((f) => taskKeys.has(f))
console.log(`  a due-date field                   : ${dueField ?? 'NONE'}`)
if (dueField) {
  const withDue = tasks.filter((t) => t[dueField]).length
  console.log(`  tasks carrying one                 : ${withDue} of ${tasks.length}`)
  const overdue = tasks.filter((t) => !isDone(t) && t[dueField] && String(t[dueField]) < new Date().toISOString()).length
  console.log(`  >> OPEN AND PAST DUE               : ${overdue}`)
}
const buyerPromise = calls.filter((c) => /they (said|agreed|promised|will)/i.test(String(c.summary?.executive ?? ''))).length
console.log(`  calls whose summary mentions a promise BY the buyer (rough) : ${buyerPromise}`)
console.log('')

// --- #5 what changed since last call ----------------------------------------
// "Diff the dossier." What can actually move between two calls, from records.
console.log('#5 WHAT CHANGED SINCE LAST CALL — needs something to have MOVED')
let movedStage = 0
let movedTask = 0
let newObjection = 0
let newSummary = 0
for (const [contactId, list] of multiCall) {
  const [newest, previous] = list
  const deal = deals.find((d) => d.contactId === contactId)
  const history: any[] = deal?.stageHistory ?? []
  if (
    history.some(
      (h) => String(h.at ?? h.changedAt ?? '') > String(previous.createdAt ?? '') && String(h.at ?? h.changedAt ?? '') <= String(newest.createdAt ?? '')
    )
  )
    movedStage++
  const mine = tasks.filter((t) => t.contactId === contactId || list.some((c) => c.id === t.callId))
  if (mine.some((t) => isDone(t))) movedTask++
  const objOf = (c: any): string =>
    String(c.coaching?.dimensions?.find((d: any) => d.key === 'objection')?.comment ?? '')
  if (objOf(newest) && objOf(newest) !== objOf(previous)) newObjection++
  if (newest.summary?.executive) newSummary++
}
console.log(`  contacts where a DEAL STAGE moved between the last two calls : ${movedStage}`)
console.log(`  contacts with a task completed                              : ${movedTask}`)
console.log(`  contacts whose newest call has a DIFFERENT objection read    : ${newObjection}`)
console.log(`  contacts whose newest call has a summary at all              : ${newSummary}`)
console.log(`  >> contacts where SOMETHING can be said to have changed      : ${
  (() => {
    let n = 0
    for (const [contactId, list] of multiCall) {
      const [newest, previous] = list
      const deal = deals.find((d) => d.contactId === contactId)
      const history: any[] = deal?.stageHistory ?? []
      const stage = history.some(
        (h) => String(h.at ?? h.changedAt ?? '') > String(previous.createdAt ?? '') && String(h.at ?? h.changedAt ?? '') <= String(newest.createdAt ?? '')
      )
      const mine = tasks.filter((t) => t.contactId === contactId || list.some((c) => c.id === t.callId))
      const objOf = (c: any): string =>
        String(c.coaching?.dimensions?.find((d: any) => d.key === 'objection')?.comment ?? '')
      if (stage || mine.some((t) => isDone(t)) || (objOf(newest) && objOf(newest) !== objOf(previous)) || newest.summary?.executive) n++
    }
    return n
  })()
} of ${multiCall.length}`)
console.log('')

// --- #7 post-call informed by this buyer ------------------------------------
// "Last time the recap that moved this deal led with the integration timeline."
// That needs to know which recap MOVED the deal — outcome data linking a
// follow-up to a stage change.
console.log('#7 POST-CALL INFORMED BY THIS BUYER — needs OUTCOME data')
const stageHistories = deals.filter((d) => Array.isArray(d.stageHistory) && d.stageHistory.length > 1)
console.log(`  deals with more than one recorded stage transition : ${stageHistories.length} of ${deals.length}`)
console.log(`  deals with a risk assessment                       : ${deals.filter((d) => d.riskAssessment).length} of ${deals.length}`)
console.log(`  calls carrying a stored follow-up/recap draft      : ${calls.filter((c) => c.followUp || c.recap || c.crmNote).length}`)
console.log(`  deals marked won or lost                          : ${deals.filter((d) => /won|lost/i.test(String(d.stageId ?? d.status ?? ''))).length}`)
console.log('')
console.log('A zero above means the mechanism is missing OR the population is empty.')
console.log('Each line names which, so a cut can carry the corpus size it would need.')
