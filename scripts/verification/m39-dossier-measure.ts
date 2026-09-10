/**
 * M39 Stage 3 — measure the client dossier BUILDER on the founder's real
 * records.
 *
 * ⚠ THIS IS NOT THE PRODUCT PATH, AND ITS NUMBERS ARE NOT PRODUCT NUMBERS.
 * It loads the five directories itself and calls `buildClientDossier` directly.
 * `m39-ensuredossier-measure.ts` is the one that enters where live-cue.ts
 * enters — at `ensureDossier` — and that is the script to quote from.
 *
 * This one survives because it reports things `ensureDossier` does not expose:
 * per-contact section counts, how many lines the cap DROPPED, and the size
 * distribution. Use it to tune the builder; never to describe what the app does.
 *
 * TWO CLAIMS FROM THIS FILE REACHED THE FOUNDER AND WERE WRONG, both because
 * "the builder" was read as "the product":
 *   - it resolved `stageLabel` from deal-stages.json while dossier-store.ts
 *     passed `null`, so the measured dossier had a deal stage and the shipped
 *     one did not — for three commits and one screenshot;
 *   - it timed 0.07 ms of string assembly over arrays already in memory, which
 *     was reported as "0.00% of the 2,290 ms baseline". The real cost in front
 *     of the first cue is the five directory reads: 281–441 ms.
 * A verification script that RE-IMPLEMENTS a step leaves that step unverified.
 *
 * READ-ONLY. Every open here is a read; nothing is written.
 *
 * THE FOUR QUESTIONS, and why each one is asked:
 *   1. HOW MUCH does it produce? A dossier that is 40 characters on every
 *      contact costs a prompt change for nothing.
 *   2. IS IT STABLE? Prompt caching needs a byte-identical prefix. Built twice
 *      over the same records, the two strings must be equal — and this is the
 *      check that catches a relative date or an unordered map.
 *   3. WHAT DOES IT COST? Characters, and the assembly time, against BUG-225's
 *      2,290 ms live-cue baseline and its 6,000 ms budget.
 *   4. WHERE IS IT EMPTY? A mean over contacts with no records hides the
 *      distribution; the count of contacts that get NOTHING is the number that
 *      decides whether this feature exists for a rep or not.
 *
 * usage: npx tsx --tsconfig tsconfig.node.json scripts/verification/m39-dossier-measure.ts <profileDir>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildClientDossier,
  DEFAULT_DOSSIER_CHARS,
  type DossierCall,
  type DossierContact,
  type DossierDeal,
  type DossierTask
} from '../../src/main/live/clientDossier'

const PROFILE = process.argv[2]
if (!PROFILE) {
  console.error('usage: m39-dossier-measure.ts <profileDir>')
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

const contacts = readAll<DossierContact>('contacts')
const calls = readAll<DossierCall>('calls')
const tasks = readAll<DossierTask>('tasks')
const deals = readAll<DossierDeal>('deals')
const objections = readAll<import('../../src/main/live/objectionPreload').MinedObjection>('objection-queue')
// Frozen, and passed rather than read inside the builder — the same value for
// every contact here, so the comparison between them is not also a comparison
// between two moments.
const ASOF = new Date().toISOString()
const stages: { id?: string; name?: string; label?: string }[] = (() => {
  const p = join(PROFILE, 'deal-stages.json')
  if (!existsSync(p)) return []
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(raw) ? raw : (raw?.stages ?? [])
  } catch {
    return []
  }
})()
const stageLabel = (id?: string): string | null => {
  const s = stages.find((x) => x.id === id)
  return (s?.name ?? s?.label) || null
}

console.log(
  `corpus: ${calls.length} call records, ${contacts.length} contacts, ${deals.length} deals, ${tasks.length} tasks`
)
console.log(`cap: ${DEFAULT_DOSSIER_CHARS} chars`)
console.log('')

// --- 1 & 4: how much, and for whom nothing ---------------------------------
const rows = contacts.map((contact) => {
  const deal = deals.find((d) => d.contactId === contact.id) ?? null
  const d = buildClientDossier({
    contact,
    deal,
    stageLabel: stageLabel(deal?.stageId),
    calls,
    tasks,
    objections,
    asOf: ASOF
  })
  return { name: contact.name, chars: d.chars, sections: d.sections.length, dropped: d.dropped, text: d.text }
})

const nonEmpty = rows.filter((r) => r.chars > 0)
const empty = rows.length - nonEmpty.length
const sorted = [...nonEmpty].sort((a, b) => b.chars - a.chars)
const median = sorted.length ? sorted[Math.floor(sorted.length / 2)].chars : 0
console.log(`contacts with a dossier            : ${nonEmpty.length} of ${rows.length}`)
console.log(`contacts that get NOTHING          : ${empty}  <- the number that decides whether this exists for a rep`)
console.log(`chars — max ${sorted[0]?.chars ?? 0}, median ${median}, min ${sorted[sorted.length - 1]?.chars ?? 0}`)
console.log(`contacts hitting the cap (dropped>0): ${nonEmpty.filter((r) => r.dropped > 0).length}`)
console.log(`sections filled — max ${Math.max(0, ...nonEmpty.map((r) => r.sections))}`)
console.log('')
console.log('top 5 by size:')
for (const r of sorted.slice(0, 5)) {
  console.log(`  ${String(r.chars).padStart(4)} chars, ${r.sections} sections, ${r.dropped} dropped — ${r.name}`)
}

// --- 2: is it byte-stable? --------------------------------------------------
let unstable = 0
for (const contact of contacts) {
  const deal = deals.find((d) => d.contactId === contact.id) ?? null
  const args = { contact, deal, stageLabel: stageLabel(deal?.stageId), calls, tasks, objections, asOf: ASOF }
  if (buildClientDossier(args).text !== buildClientDossier(args).text) unstable++
}
console.log('')
console.log(`byte-identical across two builds    : ${contacts.length - unstable} of ${contacts.length}`)
if (unstable) console.log('  ^ NOT a stable prefix — prompt caching would miss on every cue.')

// --- 3: what does assembly cost? -------------------------------------------
// Warm first (module init, JIT), then time the real thing. The number that
// matters is per-CALL, since the dossier is built once when a call starts.
const target = sorted[0]
const targetContact = contacts.find((c) => c.name === target?.name)
if (targetContact) {
  const deal = deals.find((d) => d.contactId === targetContact.id) ?? null
  const args = { contact: targetContact, deal, stageLabel: stageLabel(deal?.stageId), calls, tasks, objections, asOf: ASOF }
  for (let i = 0; i < 50; i++) buildClientDossier(args)
  const N = 200
  const t0 = performance.now()
  for (let i = 0; i < N; i++) buildClientDossier(args)
  const per = (performance.now() - t0) / N
  console.log('')
  console.log(`assembly time, largest dossier      : ${per.toFixed(2)} ms  (mean of ${N}, over all ${calls.length} call records)`)
  console.log(`  as a share of BUG-225's 2,290 ms live-cue baseline : ${((per / 2290) * 100).toFixed(2)}%`)
  console.log(`  built ONCE per call, not per cue`)
  console.log('')
  console.log(`the largest dossier, verbatim (${target?.chars} chars):`)
  console.log('----------------------------------------------------------')
  console.log(target?.text)
  console.log('----------------------------------------------------------')
}
