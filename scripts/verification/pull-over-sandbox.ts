// Run a REAL sync pull over the sandbox app's REAL call file.
//
// `importCall` is only reachable at runtime through a cloud pull, and this
// sandbox deliberately refuses the cloud (BUG-186) — pointing it at the real
// Supabase to get a round trip would be exactly the thing that guard exists to
// stop. So the pull is driven here instead: the app's own `callBackupPayload`
// builds the row the cloud would hold, the app's own `importCall` applies it
// to the app's own file, and then the running app is asked to re-read it.
//
// Nothing is simulated except the network hop.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { callBackupPayload, importCall, type Call } from '../../src/main/calls-fs'

const PROFILE = process.argv[2]
const id = process.argv[3]
if (!PROFILE || !id) {
  throw new Error('usage: pull-over-sandbox.ts <userDataDir> <callId>')
}
const CALLS = join(PROFILE, 'calls')

const read = (): Call => JSON.parse(readFileSync(join(CALLS, `${id}.json`), 'utf8'))
const show = (label: string, c: Call): void => {
  console.log(
    `${label.padEnd(22)} endedAt=${JSON.stringify(c.endedAt)}  salesBrainExcluded=${JSON.stringify(
      c.salesBrainExcluded
    )}  notes=${JSON.stringify(c.notes)}  callType=${JSON.stringify(c.callType)}`
  )
}

async function main(): Promise<void> {
const before = read()
show('BEFORE the pull', before)

// The row the cloud actually holds for this call — built by the app's own
// projection, so the fields it omits are omitted for the real reason.
const row = callBackupPayload(before) as Record<string, unknown>
console.log('')
console.log('the cloud row carries these keys:')
console.log('  ' + Object.keys(row).sort().join(', '))
for (const k of ['endedAt', 'salesBrainExcluded', 'notes', 'callType']) {
  console.log(`  ${k} in row? ${k in row}`)
}

// A pull applies a row that is NEWER than the local record. That is the case
// that overwrites, and it is the one that was losing data.
row.updatedAt = new Date(Date.now() + 60_000).toISOString()

console.log('')
console.log('running importCall (the pull-apply path) ...')
await importCall(CALLS, row, { onlyIfNewer: true })

const after = read()
show('AFTER the pull', after)

const lost = (['endedAt', 'salesBrainExcluded'] as const).filter(
  (k) => before[k] !== undefined && after[k] === undefined
)
console.log('')
console.log(lost.length ? `LOST BY THE PULL: ${lost.join(', ')}` : 'NOTHING LOST BY THE PULL')
}

void main()
