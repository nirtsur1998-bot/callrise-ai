/**
 * BUG-259 follow-up — does a reasoning model EVER reach a title inside the
 * 60-token ceiling, or does the fix only stop the symptom?
 *
 * The founder's question, exactly: *"Don't ship the fix believing it solves the
 * problem if it only stops the symptom."* The validator now rejects a reasoning
 * preamble and falls back to "Call · Sep 9, 2026, 11:03 AM". That is strictly
 * better than a garbage title and it is still not a title. If the model burns
 * its whole budget thinking, the founder gets date titles forever.
 *
 * So: run the app's OWN title request — same TEXT_PROMPT, same shape — against
 * the reasoning-capable models in the catalog, at the shipped ceiling and at a
 * raised one, and report for each:
 *   - did anything come back
 *   - did `titleFromText` extract a title from it
 *   - how many output tokens it actually spent
 *
 * That decides between the two fixes the founder named: raise the ceiling for
 * this call, or route titles away from reasoning models.
 *
 * Keys are decrypted with safeStorage against a throwaway profile and handed to
 * the child in its ENVIRONMENT only — never a command line.
 *
 * Usage, from the worktree root:
 *   node_modules/electron/dist/electron.exe scripts/verification/bug259-maxtokens.cjs
 */
const { app, safeStorage } = require('electron')
const { readFileSync, existsSync, mkdirSync, rmSync, copyFileSync } = require('node:fs')
const { join } = require('node:path')
const { spawn } = require('node:child_process')
const os = require('node:os')

const REPO = join(__dirname, '..', '..')
const LIVE_PROFILE = join(process.env.APPDATA || '', 'sales-os')
const SCRATCH = join(os.tmpdir(), 'callrise-bug259-profile')

function die(msg) {
  process.stderr.write('FAILED: ' + msg + '\n')
  app.exit(1)
}

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

  const keys = {}
  for (const [envName, file] of [
    ['GROQ', 'GROQ_API_KEY.enc'],
    ['OPENROUTER', 'OPENROUTER_API_KEY.enc'],
    ['ANTHROPIC', 'ANTHROPIC_API_KEY.enc']
  ]) {
    const p = join(LIVE_PROFILE, 'ai-keys', file)
    if (!existsSync(p)) continue
    try {
      const k = safeStorage.decryptString(readFileSync(p))
      if (k && k.length > 20) keys[envName] = k
    } catch {
      /* a key that will not decrypt is simply absent for this run */
    }
  }
  if (Object.keys(keys).length === 0) die('no usable provider keys')
  console.log(`[bug259] keys available: ${Object.keys(keys).join(', ')}`)

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  if (process.argv.includes('--ceilings')) env.BUG259_CEILINGS = process.argv[process.argv.indexOf('--ceilings') + 1]
  for (const [k, v] of Object.entries(keys)) env[`BUG259_${k}`] = v

  const child = spawn(process.execPath, [join(__dirname, 'bug259-maxtokens-run.cjs')], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (d) => (out += d.toString()))
  child.stderr.on('data', (d) => (out += d.toString()))
  child.on('close', (code) => {
    for (const v of Object.values(keys)) {
      if (out.includes(v)) {
        process.stderr.write('REFUSING TO PRINT: the child echoed an API key.\n')
        app.exit(1)
        return
      }
    }
    process.stdout.write(out)
    rmSync(SCRATCH, { recursive: true, force: true })
    app.exit(code ?? 1)
  })
})
