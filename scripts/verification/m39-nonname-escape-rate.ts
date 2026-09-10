// M39 — the ESCAPE RATE of the non-name guard, measured against real data.
//
// Species 86: a word list catches every example it was built from, which reads
// as coverage. The only honest number comes from a corpus the list was not
// written against — so this runs the real guard over every model-produced
// speaker-identity name on a real profile and reports BOTH directions:
//
//   - CAUGHT   — non-names the guard now rejects (the fix working)
//   - MISSED   — non-names still getting through (the escape, if any)
//   - EATEN    — REAL names the guard wrongly rejects (the cost, and the one
//                that matters more, because a wrong strip deletes a person)
//
// usage: npx tsx scripts/verification/m39-nonname-escape-rate.ts <callsDir>
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isAbsenceAnswer, isNonName } from '../../src/main/ai/model-placeholders'

const callsDir = process.argv[2]
if (!callsDir) {
  console.error('usage: m39-nonname-escape-rate.ts <callsDir>')
  process.exit(1)
}

const counts = new Map<string, number>()
let calls = 0
for (const f of readdirSync(callsDir).filter((n) => n.endsWith('.json'))) {
  try {
    const c = JSON.parse(readFileSync(join(callsDir, f), 'utf8'))
    calls++
    for (const v of Object.values((c.speakerIdentities ?? {}) as Record<string, { name?: unknown; source?: unknown }>)) {
      if (v && typeof v.name === 'string' && v.source === 'self-intro') {
        counts.set(v.name, (counts.get(v.name) ?? 0) + 1)
      }
    }
  } catch {
    /* an unreadable record is not a measurement */
  }
}

// The ground truth, stated explicitly rather than derived from the guard being
// tested — a classifier judged by its own output measures nothing.
const KNOWN_NON_NAMES = new Set(['someone'])

const rows = [...counts.entries()].sort((a, b) => b[1] - a[1])
const before = { caught: 0, missed: 0, eaten: 0 }
const after = { caught: 0, missed: 0, eaten: 0 }
const detail: string[] = []

for (const [name, n] of rows) {
  const truthIsNonName = KNOWN_NON_NAMES.has(name.trim().toLowerCase())
  const oldSays = isAbsenceAnswer(name)
  const newSays = isNonName(name)
  if (truthIsNonName) {
    oldSays ? (before.caught += n) : (before.missed += n)
    newSays ? (after.caught += n) : (after.missed += n)
    detail.push(`  NON-NAME  ${JSON.stringify(name).padEnd(16)} x${n}  before=${oldSays ? 'caught' : 'MISSED'}  after=${newSays ? 'caught' : 'MISSED'}`)
  } else {
    if (oldSays) before.eaten += n
    if (newSays) {
      after.eaten += n
      detail.push(`  REAL NAME EATEN  ${JSON.stringify(name)} x${n}  <-- FALSE POSITIVE`)
    }
  }
}

const instances = rows.reduce((s, [, n]) => s + n, 0)
console.log(`corpus: ${calls} calls, ${instances} self-intro identities, ${rows.length} distinct names`)
console.log(`ground truth: ${KNOWN_NON_NAMES.size} distinct non-name(s), stated by hand`)
console.log('')
console.log('                 caught   missed   real-names-eaten')
console.log(`  isAbsenceAnswer   ${String(before.caught).padStart(3)}      ${String(before.missed).padStart(3)}        ${String(before.eaten).padStart(3)}`)
console.log(`  isNonName         ${String(after.caught).padStart(3)}      ${String(after.missed).padStart(3)}        ${String(after.eaten).padStart(3)}`)
console.log('')
console.log(detail.join('\n'))
console.log('')
console.log('WHAT THIS DOES NOT SAY: the corpus holds one distinct escape, so this')
console.log('shows the fix catches the one real case. The rate for unseen phrasings')
console.log('is UNKNOWN, not zero.')
