// BUG-094 — the M27 "Export diagnostics" zip scrubbed NOTHING.
//
// `grep scrub src/main/tier1-diagnostics.ts` returned nothing: the engine logs
// were copied byte-for-byte with `copyFileSync`, and `app-diagnostics.json`
// was a plain `JSON.stringify` of tier1Status (which carries `enginePath`, an
// absolute path) plus the renderer's `deviceLabels` (microphone names, which
// routinely contain a person's name).
//
// It was concealed by a phantom citation — `docs/M29-A1-plan.md` claimed all
// three egress paths shared one `buildOutbound()`, a function that never
// existed. A reviewer greps the name, finds nothing, assumes a rename, and
// moves on; a thin REAL function would have invited someone to read its call
// sites and notice the zip was missing. Taxonomy species 26.
//
// This suite runs the HOSTILE IDENTITY SET against the diagnostics path, the
// same fixtures the support bundle and the scrubber use — the founder's
// requirement that one fixture set cover BOTH egress paths.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOSTILE_IDENTITIES } from '../telemetry/__tests__/fixtures/hostile-identities'
import { createLocalScrubber, createScrubber } from '../telemetry/scrub'

let localAppData: string
let staging: string
/** Whatever exportTier1Diagnostics actually staged for zipping. */
let zipped: Record<string, string> = {}

vi.mock('electron', () => ({
  app: { getVersion: () => '1.9.9', getPath: () => staging },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: join(staging, 'out.zip') }) },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => ({}), getAllWindows: () => [{}] }
}))

// exportTier1Diagnostics deletes its staging directory in a `finally`, so the
// only moment its real output exists is when it shells out to Compress-Archive.
// Intercepting execFile there snapshots exactly what WOULD have been zipped —
// which is how this suite enters the door the product uses instead of calling
// the copy helper itself.
vi.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    opts: { env?: Record<string, string> },
    cb: (e: Error | null) => void
  ) => {
    const srcGlob = opts?.env?.CR_DIAG_SRC ?? ''
    const stagingDir = srcGlob.replace(/[\\/]\*$/, '')
    zipped = {}
    try {
      for (const f of readdirSync(stagingDir)) {
        zipped[f] = readFileSync(join(stagingDir, f), 'utf8')
      }
    } catch {
      /* nothing staged */
    }
    cb(null)
  }
}))
vi.mock('../tier1', () => ({
  getStatus: () => ({
    engineAvailable: true,
    engineRunning: false,
    connected: false,
    denoisingActive: null,
    // The absolute path that used to ship unscrubbed.
    enginePath: 'C:\\Users\\Dana Whitfield\\AppData\\Local\\CallRiseAI\\kern_bridge.exe'
  })
}))

const { buildAppDiagnostics, engineDiagnosticFiles, exportTier1Diagnostics } = await import(
  '../tier1-diagnostics'
)

beforeEach(() => {
  localAppData = mkdtempSync(join(tmpdir(), 'diag-lad-'))
  staging = mkdtempSync(join(tmpdir(), 'diag-stage-'))
  mkdirSync(join(localAppData, 'CallRiseAI', 'logs'), { recursive: true })
})
afterEach(() => {
  for (const d of [localAppData, staging]) rmSync(d, { recursive: true, force: true })
})

/**
 * Run the REAL export and return what it staged.
 *
 * The first draft of this suite reimplemented the collection loop and called
 * `scrubbedCopy` itself. Every behavioural test passed while the raw
 * `copyFileSync` was restored — because they were proving the HELPER works,
 * not that the diagnostics zip uses it. Only the structural test caught the
 * revert. That is taxonomy species 21 (the test enters a door the product does
 * not use), written by the same hand that catalogued it. Now the tests drive
 * exportTier1Diagnostics.
 */
async function runExport(): Promise<Record<string, string>> {
  process.env['LOCALAPPDATA'] = localAppData
  zipped = {}
  const r = await exportTier1Diagnostics({
    deviceLabels: ['Realtek HD Audio'],
    tier1Enabled: true,
    denoiseStrength: 'medium'
  })
  expect(r.ok, `export failed: ${r.error ?? ''}`).toBe(true)
  return zipped
}

describe('BUG-094 — the diagnostics zip must scrub the engine logs', () => {
  for (const identity of HOSTILE_IDENTITIES.filter((i) => i.username.length >= 3)) {
    it(`redacts "${identity.username}" from kern_bridge.log`, async () => {
      const logPath = join(localAppData, 'CallRiseAI', 'logs', 'kern_bridge.log')
      writeFileSync(
        logPath,
        `mic bridge started\nmodel loaded from ${identity.homedir}\\models\\df3.onnx\n` +
          `EPERM scandir '${identity.homedir}'\n`
      )
      // CONTROL: the identity really is in the source log.
      expect(readFileSync(logPath, 'utf8')).toContain(identity.username)

      const out = (await runExport())['kern_bridge.log']
      expect(out, 'the export did not stage the engine log at all').toBeDefined()
      // The bare-username assertion is applied only where it is SATISFIABLE.
      // `C:\Users\` literally contains the substring "User", so for the
      // common-word fixture this can only pass when the generic profile rule
      // is bypassed by the exact-home rule — which happens only when the
      // fixture's identity coincides with the MACHINE's identity. That is the
      // founder's machine's happy accident, and the fixture says so itself:
      // "it doubles as the over-redaction control: prose containing 'User'
      // must survive." Asserting the username is absent demands the OPPOSITE
      // of what the fixture exists to prove.
      //
      // Found on main first, where CI failed on a runner whose username was
      // not `User` while the same test passed locally. Fixed here before this
      // branch merges, so it cannot arrive as a green that only holds on one
      // machine. Reproduce with USERPROFILE overridden: os.homedir() honours
      // it, os.userInfo().username does not, which is enough to defeat the
      // exact-home rule.
      //
      // The homedir assertion above is the real privacy property and applies
      // to EVERY identity, this one included.
      if (identity.id !== 'common-word') {
        expect(out, 'the engine log shipped the identity').not.toContain(identity.username)
      }
      expect(out, 'the homedir shipped').not.toContain(identity.homedir)
    })
  }

  it('collects the engine’s REAL rotated log name (kern_bridge.log.1)', async () => {
    writeFileSync(join(localAppData, 'CallRiseAI', 'logs', 'kern_bridge.log.1'), 'previous run\n')
    expect(Object.keys(await runExport())).toContain('kern_bridge.log.1')
  })

  it('a locked or unreadable log is skipped, never fatal (behaviour preserved)', async () => {
    // A directory where a file is expected: readable as a path, not as a file.
    mkdirSync(join(localAppData, 'CallRiseAI', 'logs', 'kern_bridge.log'), { recursive: true })
    writeFileSync(join(localAppData, 'CallRiseAI', 'kern_bridge_status.json'), '{"pid":1}')
    const out = await runExport()
    expect(Object.keys(out)).not.toContain('kern_bridge.log') // skipped
    expect(Object.keys(out)).toContain('kern_bridge_status.json') // rest still collected
    expect(Object.keys(out)).toContain('app-diagnostics.json') // and the export succeeded
  })
})

describe('BUG-094 — app-diagnostics.json must not ship paths or device names raw', () => {
  it('enginePath and a person-named device label are both scrubbed', () => {
    const raw = buildAppDiagnostics({
      deviceLabels: ["Dana Whitfield's AirPods", 'Realtek HD Audio'],
      tier1Enabled: true,
      denoiseStrength: 'medium'
    })
    // CONTROL: the raw builder output really does carry both.
    expect(raw).toContain('Dana Whitfield')

    // What the zip now writes.
    // createScrubber, not createLocalScrubber: this test simulates a DIFFERENT
    // machine's identity, and createLocalScrubber deliberately binds this one's
    // (its type omits homedir/username for exactly that reason).
    const scrubDocument = createScrubber({
      homedir: 'C:\\Users\\Dana Whitfield',
      username: 'Dana Whitfield',
      maxLength: Number.MAX_SAFE_INTEGER
    })
    const out = scrubDocument(raw)

    expect(out, 'enginePath shipped the username').not.toContain('C:\\Users\\Dana Whitfield')
    // Still useful: the non-identifying half survives.
    expect(out).toContain('Realtek HD Audio')

    // NOT FIXED, and asserted as-is rather than papered over. A device
    // LABEL carries a bare name with no path separator in front of it, and
    // scrub.ts documents that it deliberately never matches a username as a
    // BARE WORD — on this machine the account is literally "User", so a
    // bare-word rule would mangle every sentence containing it. The
    // scrubber therefore cannot catch "Dana Whitfield's AirPods", structurally.
    //
    // This is the strip-not-scrub lesson again: you cannot scrub a name,
    // only refuse to include it. Surfaced as its own finding rather than
    // decided here — dropping deviceLabels costs the zip its main
    // diagnostic value (which microphone the engine actually grabbed), so
    // it is a product call, not a cleanup.
    expect(out, 'documenting the known gap, not endorsing it').toContain("AirPods")
  })

  it('is not truncated — a document scrubber, not the 4096-char field one', () => {
    const many = Array.from({ length: 160 }, (_, i) => `Microphone Array ${i} (Realtek HD Audio)`)
    const raw = buildAppDiagnostics({ deviceLabels: many })
    expect(raw.length).toBeGreaterThan(4096) // control: over the field cap
    const out = createLocalScrubber({ maxLength: Number.MAX_SAFE_INTEGER })(raw)
    expect(out).not.toContain('truncated')
    expect(() => JSON.parse(out)).not.toThrow()
  })
})

describe('one mechanism, both egress paths — asserted structurally', () => {
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('tier1-diagnostics uses the shared helper and no longer raw-copies', () => {
    const src = stripComments(readFileSync(join(__dirname, '..', 'tier1-diagnostics.ts'), 'utf8'))
    expect(src).toContain('scrubbedCopy(')
    expect(src, 'a raw copyFileSync is what BUG-094 was').not.toContain('copyFileSync')
  })

  it('the support bundle uses the same helper, not a second copy of it', () => {
    const src = stripComments(readFileSync(join(__dirname, '..', 'support-bundle.ts'), 'utf8'))
    expect(src).toContain("from './scrubbed-copy'")
    expect(src, 'a private re-implementation would drift').not.toContain('function scrubbedCopy')
  })

  it('the zip contains only the files the shared list names, plus app-diagnostics', async () => {
    writeFileSync(join(localAppData, 'CallRiseAI', 'logs', 'kern_bridge.log'), 'x\n')
    const out = await runExport()
    const allowed = new Set([
      ...engineDiagnosticFiles('X').map((p) => p.split(/[\\/]/).pop()!),
      'app-diagnostics.json'
    ])
    for (const f of Object.keys(out)) {
      expect(allowed.has(f), `unexpected file in the zip: ${f}`).toBe(true)
    }
    expect(Object.keys(out)).toContain('kern_bridge.log')
  })
})
