// Red-then-green for the state guard's NEW ability: restoring key FILES.
// Deliberately operates only on files this test creates -- proving a deleted
// key comes back must not be demonstrated on a real credential.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
const { withRestoredState } = await import('file:///C:/Users/User/Desktop/callrise-m32/scripts/verification/state-guard.mjs')

const DIR = 'C:/Users/User/AppData/Roaming/sales-os/ai-keys'
const CANARY = join(DIR, 'ZZZ_SELFTEST_CANARY.enc')
const ADDED = join(DIR, 'ZZZ_SELFTEST_ADDED.enc')
const BYTES = Buffer.from('canary-contents-that-must-survive')

const realBefore = ['DEEPGRAM_API_KEY.enc', 'GROQ_API_KEY.enc', 'CLOUDFLARE_API_KEY.enc']
  .map((f) => [f, existsSync(join(DIR, f)) ? readFileSync(join(DIR, f)).toString('base64') : null])

writeFileSync(CANARY, BYTES)
console.log('canary planted')

await withRestoredState(async () => {
  unlinkSync(CANARY)                      // simulates the destroyed-credential incident
  writeFileSync(ADDED, Buffer.from('a throwaway key a check saved'))
  console.log('  [inside] canary DELETED, throwaway ADDED')
  if (existsSync(CANARY)) throw new Error('canary should be gone inside the run')
}, { allowKeyChanges: ['ZZZ_SELFTEST_ADDED'] })

const canaryBack = existsSync(CANARY) && readFileSync(CANARY).equals(BYTES)
const addedGone = !existsSync(ADDED)
console.log('')
console.log('CANARY RESTORED byte-identical :', canaryBack ? 'YES' : '*** NO ***')
console.log('THROWAWAY CLEANED UP           :', addedGone ? 'YES' : '*** NO ***')

const realOk = realBefore.every(
  ([f, b]) => (existsSync(join(DIR, f)) ? readFileSync(join(DIR, f)).toString('base64') : null) === b
)
console.log('REAL KEYS UNTOUCHED            :', realOk ? 'YES' : '*** NO ***')

if (existsSync(CANARY)) unlinkSync(CANARY)
console.log('canary cleaned up')
if (!canaryBack || !addedGone || !realOk) process.exit(1)
