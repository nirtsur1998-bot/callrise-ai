// BUG-243 — run the transcripts-scrub REPUSH over a real profile and show
// which clock it moves.
//
// `touchAllCallsForRepush` is reachable at runtime only from
// `drainPendingScrubs`, i.e. only inside a cloud push — and a sandbox refuses
// the cloud by design (BUG-186: a profile copy that reaches the real backend is
// one step from a copy overwriting it). So the repush is driven here instead:
// the app's own function, over the app's own files, with the running app asked
// afterwards what it now sees. The only simulated part is the network hop that
// would have called it.
//
// usage: repush-over-sandbox.ts <userDataDir> <callId>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { touchAllCallsForRepush, type Call } from '../../src/main/calls-fs'

const PROFILE = process.argv[2]
const id = process.argv[3]
if (!PROFILE || !id) throw new Error('usage: repush-over-sandbox.ts <userDataDir> <callId>')
const CALLS = join(PROFILE, 'calls')

const read = (): Call => JSON.parse(readFileSync(join(CALLS, `${id}.json`), 'utf8'))
const show = (label: string, c: Call): void =>
  console.log(
    `${label.padEnd(22)} updatedAt=${c.updatedAt}  editedAt=${JSON.stringify(c.editedAt ?? null)}`
  )

async function main(): Promise<void> {
  const before = read()
  show('BEFORE the repush', before)

  console.log('')
  console.log('running touchAllCallsForRepush (what a transcripts scrub does) ...')
  const touched = await touchAllCallsForRepush(CALLS)
  console.log(`  touched ${touched} call(s)`)
  console.log('')

  const after = read()
  show('AFTER the repush', after)

  console.log('')
  const syncKeyMoved = Date.parse(after.updatedAt) > Date.parse(before.updatedAt)
  const editStampHeld = (after.editedAt ?? null) === (before.editedAt ?? null)
  console.log(`sync key moved (required, or the scrub cannot evict): ${syncKeyMoved}`)
  console.log(`edit stamp held (required, or 196 records lose their history): ${editStampHeld}`)
  console.log('')
  console.log(
    syncKeyMoved && editStampHeld
      ? 'THE SPLIT HOLDS'
      : 'THE SPLIT IS BROKEN — this is the BUG-243 shape returning'
  )
}

void main()
