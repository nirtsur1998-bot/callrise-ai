/**
 * M39 Stage 4 #1 — how many real contacts get an objection pre-load, and what
 * does it actually say to a rep?
 *
 * READ-ONLY. The count is the feature's value, stated up front, the same way
 * "6 of 297" was for the disagreement surface.
 *
 * usage: npx tsx --tsconfig tsconfig.node.json scripts/verification/m39-preload-measure.ts <profileDir>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildObjectionPreload, formatObjectionPreload } from '../../src/main/live/objectionPreload'

const P = process.argv[2]
if (!P) {
  console.error('usage: m39-preload-measure.ts <profileDir>')
  process.exit(1)
}
/* eslint-disable @typescript-eslint/no-explicit-any */
function readAll(dir: string): any[] {
  const p = join(P, dir)
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
const calls = readAll('calls')
const objections = readAll('objection-queue')

let withPreload = 0
let withSomethingThatWorked = 0
let withNothingThatWorked = 0
const shown: string[] = []
for (const c of contacts) {
  const pre = buildObjectionPreload({ contactId: c.id, calls, objections })
  if (!pre.length) continue
  withPreload++
  for (const p of pre) (p.whatWorked ? withSomethingThatWorked : withNothingThatWorked)
  withSomethingThatWorked += pre.filter((p) => p.whatWorked).length ? 0 : 0
  shown.push(`  ${c.name}:\n` + formatObjectionPreload(pre).map((l) => `    - ${l}`).join('\n'))
}
const allPatterns = contacts.flatMap((c) => buildObjectionPreload({ contactId: c.id, calls, objections }))
console.log(`mined objections on this profile        : ${objections.length}`)
console.log(`  typed 'other' (excluded by design)    : ${objections.filter((o) => String(o.type).toLowerCase() === 'other').length}`)
console.log(`contacts with a repeated objection type : ${withPreload} of ${contacts.length}`)
console.log(`patterns found                          : ${allPatterns.length}`)
console.log(`  ...with a response that LANDED        : ${allPatterns.filter((p) => p.whatWorked).length}`)
console.log(`  ...with nothing that has landed yet   : ${allPatterns.filter((p) => !p.whatWorked).length}`)
console.log('')
console.log(shown.join('\n'))
