/**
 * BUG-167 landing — does the MERGED category description cost extraction quality?
 *
 * The founder's condition on landing BUG-167: *"Two instructions that are each
 * correct can still make a worse prompt together."* Nobody has run the
 * extraction harness against the combination, because neither branch shipped
 * it.
 *
 * This runs `memory-quality-eval.test.ts` — the REAL harness, the REAL
 * extraction path, a REAL network call — against whichever prompt is in the
 * working tree, and prints its report.
 *
 * THE KEY IS NEVER ON A COMMAND LINE. A command line is visible to every
 * process on the machine via the process table, so the decrypted key is passed
 * to the child through its ENVIRONMENT and nowhere else. It is decrypted here
 * with Electron's safeStorage against a throwaway profile holding a COPY of
 * `Local State` (the same shape cloud-ratchet.cjs uses), and the child's output
 * is asserted against the key's actual value before a byte of it is printed.
 *
 * Usage, from the worktree root:
 *   node_modules/electron/dist/electron.exe scripts/verification/bug167-prompt-eval.cjs
 */
const { app, safeStorage } = require('electron')
const { readFileSync, existsSync, mkdirSync, copyFileSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { spawn } = require('node:child_process')
const os = require('node:os')

const REPO = join(__dirname, '..', '..')
const LIVE_PROFILE = join(process.env.APPDATA || '', 'sales-os')
const SCRATCH = join(os.tmpdir(), 'callrise-prompt-eval-profile')

function die(msg) {
  process.stderr.write('FAILED: ' + msg + '\n')
  app.exit(1)
}

// MUST run before the app is ready: OSCrypt binds its key at startup from
// whatever userData is current AT THAT MOMENT, and switching later fails to
// decrypt with an error that reads like a corrupt file. cloud-ratchet.cjs
// learned this the hard way; this is the same fix.
;(function useScratchProfile() {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  const src = join(LIVE_PROFILE, 'Local State')
  if (!existsSync(src)) die(`no "Local State" at ${src} — cannot decrypt`)
  copyFileSync(src, join(SCRATCH, 'Local State'))
  app.setPath('userData', SCRATCH)
})()

app.whenReady().then(() => {
  const encPath = join(LIVE_PROFILE, 'ai-keys', 'ANTHROPIC_API_KEY.enc')
  if (!existsSync(encPath)) die(`no key at ${encPath}`)
  if (!safeStorage.isEncryptionAvailable()) die('safeStorage reports encryption unavailable')

  let key
  try {
    key = safeStorage.decryptString(readFileSync(encPath)).trim()
  } catch (e) {
    die('could not decrypt the key: ' + e.message)
  }
  if (!key || key.length < 20) die('the decrypted key looks wrong; refusing to use it')
  process.stdout.write(`key decrypted: ${key.length} chars, starts "${key.slice(0, 7)}…" (never printed in full)\n\n`)

  const child = spawn(
    process.env.COMSPEC || 'cmd.exe',
    ['/c', 'npx', 'vitest', 'run', '--reporter=verbose', 'src/main/memory/__tests__/memory-quality-eval.test.ts'],
    {
      cwd: REPO,
      env: { ...process.env, CALLRISE_EVAL: '1', ANTHROPIC_API_KEY: key },
      windowsHide: true
    }
  )

  let out = ''
  const take = (b) => {
    out += b.toString()
  }
  child.stdout.on('data', take)
  child.stderr.on('data', take)
  child.on('close', (code) => {
    // NEVER print anything before proving the secret is not in it.
    if (out.includes(key) || out.includes(key.slice(0, 20))) {
      die('REFUSING TO PRINT: the API key reached the harness output')
    }
    process.stdout.write(out)
    process.stdout.write(`\n=== harness exit ${code} ===\n`)
    app.exit(code ?? 1)
  })
}).catch((e) => die(e && e.message ? e.message : String(e)))
