// M39 Stage 3 — measure `ensureDossier`, which is the thing the PRODUCT calls.
//
// WHY THIS EXISTS SEPARATELY FROM m39-dossier-measure.ts. That script times
// `buildClientDossier` over arrays it loaded itself, and reported 0.07 ms —
// "0.00% of BUG-225's 2,290 ms baseline". That number answers for the wrong
// layer. What actually sits in front of the first cue is `ensureDossier`,
// which reads five directories off disk (contacts, calls, tasks, deals,
// objection-queue — 297 + 287 files on the founder's profile, serial within
// each directory by BUG-248's finding) BEFORE the model is ever called. The
// builder is the cheap part; the I/O is the cost, and it had never been timed.
//
// It also checks the thing the builder-level script could not: that the text
// `ensureDossier` produces CONTAINS THE DEAL STAGE. The measure script resolved
// the stage label itself, so its output read "stage: Went quiet" while the
// product hard-coded `stageLabel: null` and shipped a dossier with no stage in
// it for three commits.
//
// READ-ONLY. ensureDossier opens files and writes none.
//
// usage: npx tsx scripts/verification/m39-ensuredossier-measure.ts <userDataDir>
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDossier, clearDossier } from '../../src/main/live/dossier-store'

const PROFILE = process.argv[2]
if (!PROFILE) {
  console.error('usage: m39-ensuredossier-measure.ts <userDataDir>')
  process.exit(1)
}

const readAll = <T>(dir: string): T[] => {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(dir, f), 'utf8')) as T]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

const contacts = readAll<{ id: string; name?: string }>(join(PROFILE, 'contacts'))
const deals = readAll<{ contactId?: string; stageId?: string }>(join(PROFILE, 'deals'))
const stagesRaw = (() => {
  try {
    const raw = JSON.parse(readFileSync(join(PROFILE, 'deal-stages.json'), 'utf8'))
    return Array.isArray(raw) ? raw : (raw?.stages ?? [])
  } catch {
    return []
  }
})() as { id?: string; label?: string }[]

console.log(`profile   : ${PROFILE}`)
console.log(`contacts  : ${contacts.length}`)
console.log(`deals     : ${deals.length}`)
console.log(`stages    : ${stagesRaw.length}`)
console.log('')

async function main(): Promise<void> {
  // ---- 1. THE COLD COST. What the first cue of a call actually waits for.
  // One contact, cache empty, nothing warmed. Repeated over several distinct
  // contacts because the OS page cache makes the FIRST read of the corpus the
  // expensive one and every later one cheap — reporting only run 1 overstates
  // the steady state, reporting only run 5 understates a cold app start.
  const sample = contacts.slice(0, 5)
  const cold: number[] = []
  for (const [i, c] of sample.entries()) {
    clearDossier()
    const t0 = performance.now()
    await ensureDossier(PROFILE, `measure-call-${i}`, c.id)
    cold.push(performance.now() - t0)
  }
  console.log('COLD — ensureDossier, empty cache (this is what the first cue waits for)')
  cold.forEach((ms, i) => console.log(`  run ${i + 1} (${sample[i]?.name ?? '?'}) : ${ms.toFixed(1)} ms`))
  console.log(`  first run              : ${cold[0]!.toFixed(1)} ms   <- cold app, cold page cache`)
  console.log(
    `  median of ${cold.length}            : ${[...cold].sort((a, b) => a - b)[Math.floor(cold.length / 2)]!.toFixed(1)} ms`
  )
  console.log('')

  // ---- 2. THE WARM COST. Every cue after the first on the same call.
  clearDossier()
  const target = sample[0]!
  await ensureDossier(PROFILE, 'warm-call', target.id)
  const warm: number[] = []
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now()
    await ensureDossier(PROFILE, 'warm-call', target.id)
    warm.push(performance.now() - t0)
  }
  const warmMax = Math.max(...warm)
  console.log('WARM — same call, cached (every cue after the first)')
  console.log(`  max of 20              : ${warmMax.toFixed(4)} ms`)
  console.log('')

  // ---- 3. THE STAGE. Does the text the PRODUCT builds carry the deal stage?
  const stageLabelOf = (id?: string): string | undefined =>
    stagesRaw.find((s) => s.id === id)?.label
  const withStagedDeal = contacts.filter((c) => {
    const d = deals.find((x) => x.contactId === c.id)
    return !!d && !!stageLabelOf(d.stageId)
  })
  console.log(`contacts with a deal in a NAMED stage : ${withStagedDeal.length}`)
  let carried = 0
  let missing = 0
  for (const [i, c] of withStagedDeal.entries()) {
    clearDossier()
    const text = await ensureDossier(PROFILE, `stage-check-${i}`, c.id)
    const label = stageLabelOf(deals.find((x) => x.contactId === c.id)!.stageId)!
    if (text.includes(`stage: ${label}`)) carried++
    else {
      missing++
      if (missing <= 3) console.log(`  MISSING for ${c.name ?? c.id}: expected "stage: ${label}"`)
    }
  }
  console.log(`  dossier CARRIES the stage             : ${carried}`)
  console.log(`  dossier is MISSING it                 : ${missing}`)
  console.log('')

  // ---- 3b. COVERAGE, counted through the product path rather than the
  // builder. The handoff's "30 of 50" was counted before the `status: 'done'`
  // fix, when 24 completed tasks were still being rendered as outstanding
  // promises — which is exactly the kind of line that can carry a contact over
  // the "has something to say" threshold on its own.
  let withDossier = 0
  let empty = 0
  let longest = { name: '', chars: 0 }
  const lengths: number[] = []
  for (const [i, c] of contacts.entries()) {
    clearDossier()
    const text = await ensureDossier(PROFILE, `coverage-${i}`, c.id)
    if (text.trim()) {
      withDossier++
      lengths.push(text.length)
      if (text.length > longest.chars) longest = { name: c.name ?? c.id, chars: text.length }
    } else empty++
  }
  console.log(`COVERAGE over ${contacts.length} contacts, through ensureDossier`)
  console.log(`  gets a dossier                        : ${withDossier}`)
  console.log(`  gets nothing                          : ${empty}`)
  console.log(`  longest                               : ${longest.chars} chars (${longest.name})`)
  console.log('')

  // ---- 3c. STABILITY. The prompt prefix only pays for caching if it is
  // byte-identical between assemblies; a map iteration order or a locale
  // format would break it silently.
  let identical = 0
  for (const [i, c] of contacts.entries()) {
    clearDossier()
    const a = await ensureDossier(PROFILE, `stable-a-${i}`, c.id)
    clearDossier()
    const b = await ensureDossier(PROFILE, `stable-b-${i}`, c.id)
    if (a === b) identical++
  }
  console.log(`byte-identical across two assemblies    : ${identical} of ${contacts.length}`)
  console.log('')

  // ---- 4. One real dossier, printed, so the claim is readable rather than
  // just counted.
  const show = withStagedDeal[0]
  if (show) {
    clearDossier()
    const text = await ensureDossier(PROFILE, 'show', show.id)
    console.log(`--- the dossier the product sends for "${show.name ?? show.id}" ---`)
    console.log(text)
    console.log('--- end ---')
  }
}

void main().then(() => process.exit(0))
