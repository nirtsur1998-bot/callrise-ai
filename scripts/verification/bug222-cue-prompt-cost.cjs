/**
 * BUG-222 — does adding client facts to the LIVE CUE prompt cost anything
 * measurable?
 *
 * The founder's question, and the one BUG-225 was built to make answerable.
 * Before BUG-225 there was no measured p50 for cue latency on any machine, so
 * "it got slower" and "it did not" were equally unfalsifiable.
 *
 * WHAT IS MEASURED, AND WHY NOT THE FOUNDER'S OWN DATA.
 * On this machine `clientProfileSection()` returns an EMPTY STRING for every
 * contact: the Sales Brain holds 73 memories, 72 of them `hypothesis` with
 * exactly one distinct episode each against a promotion threshold of three, and
 * `buildProfileText` builds from ACTIVE memories only. So shipping BUG-222 here
 * today would add literally zero bytes, and measuring it on this data would
 * report "free" for the wrong reason — the change would not have been exercised.
 * That is species 107's shape: a zero is only evidence if the thing that
 * produces zeros was reached.
 *
 * So the injected section is SYNTHETIC and sized to the CAP the design permits:
 * `PROFILE_CHAR_BUDGET.micro` is 500 characters (consolidation.ts), plus the
 * ~55-character section header, which is the WORST CASE a client profile can
 * ever contribute. An answer at the cap is valid whatever the founder's brain
 * comes to hold later; an answer from today's data would expire the first time
 * a memory is promoted.
 *
 * PAIRED AND ALTERNATED. Provider latency drifts over minutes, so the two arms
 * are run back to back within a pair and the order flips every pair. An A-then-
 * all-B design would credit the prompt for a slow five minutes on the network.
 *
 * ONE PINNED MODEL. `coaching-cue` has an empty chain on this machine and
 * resolves through the default provider, which can route to different models
 * run to run — that variance would swamp a 139-token difference. Pinning
 * measures the thing the question is about.
 *
 * THE KEY IS NEVER ON A COMMAND LINE — the process table is world-readable on
 * this machine. It is decrypted here with Electron's safeStorage against a
 * throwaway profile holding a COPY of `Local State`, handed to the child in its
 * ENVIRONMENT only, and the child's output is asserted against the key's actual
 * value before a byte of it is printed. Same shape as bug167-prompt-eval.cjs.
 *
 * Usage, from the worktree root:
 *   node_modules/electron/dist/electron.exe scripts/verification/bug222-cue-prompt-cost.cjs [pairs]
 */
const { app, safeStorage } = require('electron')
const { readFileSync, existsSync, mkdirSync, rmSync, copyFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawn } = require('node:child_process')
const os = require('node:os')

const REPO = join(__dirname, '..', '..')
const LIVE_PROFILE = join(process.env.APPDATA || '', 'sales-os')
const SCRATCH = join(os.tmpdir(), 'callrise-bug222-profile')
const PAIRS = Number(process.argv[2] || 12)

function die(msg) {
  process.stderr.write('FAILED: ' + msg + '\n')
  app.exit(1)
}

// MUST run before the app is ready: OSCrypt binds its key at startup from
// whatever userData is current AT THAT MOMENT, and switching later fails to
// decrypt with an error that reads like a corrupt file.
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
  if (!key || key.length < 20) die('decrypted key looks wrong (length ' + (key || '').length + ')')

  // The prompt lives in TWO places now — live-cue.ts and bug222-arms.cjs's
  // verbatim copy — so print a fingerprint of the shipped source. If someone
  // edits the prompt and not the copy, this number moves and the harness is
  // known to be measuring yesterday's prompt instead of silently doing it.
  const shipped = readFileSync(join(REPO, 'src', 'main', 'live-cue.ts'), 'utf8')
  // liveTool() is defined ABOVE livePrompt(), so the end anchor is the next
  // declaration BELOW it, not the other helper.
  const from = shipped.indexOf('function livePrompt(')
  const to = shipped.indexOf('export async function liveCue(', from)
  if (from < 0 || to <= from) die('could not locate livePrompt() in live-cue.ts — the fingerprint would be meaningless')
  const body = shipped.slice(from, to)
  const fp = require('node:crypto').createHash('sha256').update(body).digest('hex').slice(0, 12)
  console.log(`[bug222] live-cue.ts livePrompt() fingerprint: ${fp} (${body.length} chars)`)

  const extra = process.argv.includes('--control') ? ['--control'] : []
  const child = spawn(process.execPath, [join(__dirname, 'bug222-arms.cjs'), String(PAIRS), ...extra], {
    cwd: REPO,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BUG222_KEY: key },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d.toString()))
  child.stderr.on('data', (d) => (out += d.toString()))
  child.on('close', (code) => {
    // Assert BEFORE printing. A harness that leaks the key it was careful not
    // to put on a command line has achieved nothing.
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
