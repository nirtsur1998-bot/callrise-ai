// M39 Stage 4 #5 — COUNT THE INPUT BEFORE WRITING THE FEATURE.
//
// Species 117: a zero means the mechanism is missing OR the population is
// empty, and only the second is a design decision — one that has to be made
// before the feature exists, not discovered afterwards as a blank line inside
// a cached prompt prefix. Four Stage 4 features were triaged this way in one
// night; two were built and two were cut with numbers.
//
// This measures RECORDS, not a product function, so it is not a
// re-implementation of anything: there is no "what changed" code yet. That is
// the point — the numbers below decide whether there should be.
//
// The question: between a contact's LAST call and the one before it, what
// actually moved on the founder's own records?
//
// READ-ONLY.
//
// usage: npx tsx scripts/verification/m39-whatchanged-population.ts <profileDir>
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PROFILE = process.argv[2]
if (!PROFILE) {
  console.error('usage: m39-whatchanged-population.ts <profileDir>')
  process.exit(1)
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function readAll(dir: string): any[] {
  const p = join(PROFILE, dir)
  if (!existsSync(p)) return []
  return readdirSync(p)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(p, f), 'utf8'))]
      } catch {
        return []
      }
    })
}

const contacts = readAll('contacts')
const calls = readAll('calls').filter((c) => !c.deleted)
const tasks = readAll('tasks')
const deals = readAll('deals')
const objections = readAll('objection-queue')

const isDone = (t: any): boolean =>
  t.done === true || t.status === 'done' || t.status === 'completed' || !!t.completedAt

const when = (c: any): number => Date.parse(c.createdAt ?? c.startedAt ?? '') || 0

console.log(`corpus: ${contacts.length} contacts, ${calls.length} live calls`)
console.log('')

const multi: { name: string; id: string; last: any; prev: any }[] = []
for (const contact of contacts) {
  const mine = calls.filter((c) => c.contactId === contact.id).sort((a, b) => when(b) - when(a))
  if (mine.length >= 2)
    multi.push({ name: contact.name, id: contact.id, last: mine[0], prev: mine[1] })
}
console.log(
  `contacts with 2+ calls (the only ones this can speak for): ${multi.length} of ${contacts.length}`
)
console.log('')

// ---- the four candidate signals, counted separately -----------------------
let stageMoved = 0
let taskDone = 0
let objectionChanged = 0
let newSummary = 0
let anything = 0
const examples: string[] = []

const primaryObjection = (callId: string): string | null => {
  const mine = objections.filter((o) => o.callId === callId && o.type)
  const t = mine.find(
    (o) => !['other', 'unknown', 'none', ''].includes(String(o.type).toLowerCase())
  )
  return t ? String(t.type) : null
}

for (const m of multi) {
  const reasons: string[] = []

  // 1. deal stage — needs a transition history with a timestamp inside the window
  const deal = deals.find((d) => d.contactId === m.id)
  const history: any[] = Array.isArray(deal?.stageHistory)
    ? deal.stageHistory
    : Array.isArray(deal?.transitions)
      ? deal.transitions
      : []
  const movedInWindow = history.filter((h) => {
    const t = Date.parse(h.at ?? h.changedAt ?? h.createdAt ?? '') || 0
    return t > when(m.prev) && t <= Date.now()
  })
  if (movedInWindow.length > 0) {
    stageMoved++
    reasons.push('deal stage')
  }

  // 2. a task for this contact completed since the previous call
  const completed = tasks.filter((t) => {
    if (t.contactId !== m.id || !isDone(t)) return false
    const at = Date.parse(t.completedAt ?? '') || 0
    return at > when(m.prev)
  })
  if (completed.length > 0) {
    taskDone++
    reasons.push('task completed')
  }

  // 3. the objection read changed between the two calls
  const a = primaryObjection(m.prev.id)
  const b = primaryObjection(m.last.id)
  if (a && b && a !== b) {
    objectionChanged++
    reasons.push(`objection ${a} -> ${b}`)
  }

  // 4. the last call produced a summary the previous one did not
  //    (weak: "there is a recap" is not "something changed")
  if (m.last.summary?.executive && !m.prev.summary?.executive) {
    newSummary++
    reasons.push('new summary')
  }

  if (reasons.length) {
    anything++
    if (examples.length < 8) examples.push(`  ${m.name}: ${reasons.join(', ')}`)
  }
}

console.log('WHAT MOVED between the last two calls')
console.log(`  deal stage moved            : ${stageMoved}`)
console.log(`  a task completed            : ${taskDone}`)
console.log(`  the objection read changed  : ${objectionChanged}`)
console.log(`  a summary appeared          : ${newSummary}   <- weak signal, counted separately`)
console.log(`  >> ANY of the above         : ${anything} of ${multi.length}`)
console.log('')
console.log('examples:')
for (const e of examples) console.log(e)
console.log('')

// ---- the honest denominator ----------------------------------------------
console.log('AS A SHARE OF EVERY CONTACT (what a rep would actually experience):')
console.log(`  ${anything} of ${contacts.length} contacts would ever see this line`)
console.log('')
console.log('Field availability, so a zero above can be told apart from a missing mechanism:')
console.log(
  `  deals carrying ANY stage history : ${deals.filter((d) => Array.isArray(d.stageHistory) || Array.isArray(d.transitions)).length} of ${deals.length}`
)
console.log(
  `  tasks with a completedAt stamp   : ${tasks.filter((t) => t.completedAt).length} of ${tasks.length}`
)
console.log(
  `  tasks carrying a contactId       : ${tasks.filter((t) => t.contactId).length} of ${tasks.length}`
)
console.log(
  `  objections with a usable type    : ${objections.filter((o) => o.type && !['other', 'unknown', 'none', ''].includes(String(o.type).toLowerCase())).length} of ${objections.length}`
)
