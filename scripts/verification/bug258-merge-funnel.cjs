/**
 * BUG-258 — THE DISCRIMINATING TEST.
 *
 * Zero merges have ever succeeded across 46 calls and 73 memories, and the
 * candidate explanations need OPPOSITE fixes:
 *
 *   (a) the facts really are all distinct     -> the THRESHOLD is what to change
 *   (b) `judgeSameFact` has been failing      -> its `catch { return false }` is
 *       closed and asserting non-identity        the bug; the threshold is innocent
 *   (c) the vector search never SURFACES a    -> the QUERY is the bug, and neither
 *       same-scope neighbour to judge            of the other two fixes helps
 *
 * (c) was not in the entry and came out of reading the query rather than the
 * description. `searchMemoriesByVector` asks sqlite-vec for `k = @limit` (3)
 * nearest across the WHOLE table, and only THEN filters by scope and status in
 * SQL. With 73 memories spread over 11 scopes, the global top-3 can easily be
 * three other scopes, and the post-filter leaves nothing to judge. A merge that
 * never had a candidate is indistinguishable, from the outside, from a merge
 * that was considered and declined.
 *
 * So this replays the REAL gates in the REAL order, over the REAL stored
 * vectors — not re-embedded ones, which would introduce a second variable —
 * and reports WHERE THE FUNNEL DIES.
 *
 * Read-only on the founder's profile. No statement text is ever printed: the
 * output is counts and distances. The judge is a real network call and sees
 * pairs of statements, which is exactly what it sees in production.
 *
 * Usage, from the worktree root:
 *   node_modules/electron/dist/electron.exe scripts/verification/bug258-merge-funnel.cjs [maxJudgeCalls]
 */
const { app, safeStorage } = require('electron')
const { readFileSync, existsSync, mkdirSync, rmSync, copyFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawn } = require('node:child_process')
const os = require('node:os')

const REPO = join(__dirname, '..', '..')
const LIVE_PROFILE = join(process.env.APPDATA || '', 'sales-os')
const SCRATCH = join(os.tmpdir(), 'callrise-bug258-profile')
const MAX_JUDGE = process.argv[2] || '60'

function die(msg) {
  process.stderr.write('FAILED: ' + msg + '\n')
  app.exit(1)
}

// MUST run before the app is ready — OSCrypt binds its key at startup from
// whatever userData is current AT THAT MOMENT.
;(function useScratchProfile() {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  const src = join(LIVE_PROFILE, 'Local State')
  if (!existsSync(src)) die('no Local State at ' + src)
  copyFileSync(src, join(SCRATCH, 'Local State'))
  app.setPath('userData', SCRATCH)
})()

app.whenReady().then(async () => {
  if (!safeStorage.isEncryptionAvailable()) die('safeStorage reports encryption unavailable')
  const encPath = join(LIVE_PROFILE, 'ai-keys', 'ANTHROPIC_API_KEY.enc')
  if (!existsSync(encPath)) die('no ANTHROPIC_API_KEY.enc in the live profile')
  let key
  try {
    key = safeStorage.decryptString(readFileSync(encPath))
  } catch (e) {
    die('could not decrypt the key: ' + e.message)
  }
  if (!key || key.length < 20) die('decrypted key looks wrong')

  const child = spawn(process.execPath, [join(__dirname, 'bug258-funnel-run.cjs'), MAX_JUDGE], {
    cwd: REPO,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BUG258_KEY: key },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d.toString()))
  child.stderr.on('data', (d) => (out += d.toString()))
  child.on('close', (code) => {
    if (out.includes(key)) {
      process.stderr.write('REFUSING TO PRINT: the child echoed the API key.\n')
      app.exit(1)
      return
    }
    process.stdout.write(out)
    rmSync(SCRATCH, { recursive: true, force: true })
    app.exit(code ?? 1)
  })
})
