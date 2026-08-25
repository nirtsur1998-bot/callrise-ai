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
import { HOSTILE_IDENTITIES } from '../__tests__/fixtures/hostile-identities'
import { createLocalScrubber, createScrubber } from '../scrub'

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
    enginePath: 'C:\\Users\\Nir Tsur\\AppData\\Local\\CallRiseAI\\kern_bridge.exe'
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

      // THE HOMEDIR IS THE REAL PROPERTY, and it holds for every identity: the
      // profile path must never survive, because that path IS the leak.
      expect(out, 'the homedir shipped').not.toContain(identity.homedir)

      // The bare-username assertion is applied only where it is SATISFIABLE.
      // `C:\Users\` literally contains the substring "User", so for the
      // common-word fixture this assertion can only pass when the generic
      // profile rule is bypassed by the exact-home rule — which happens only
      // when the fixture's identity coincides with the MACHINE's identity.
      // That is this machine's happy accident, and the fixture says so in its
      // own `breaks` note: "it doubles as the over-redaction control: prose
      // containing 'User' must survive." Asserting the username is absent
      // would demand the opposite of what the fixture exists to prove.
      //
      // CI CAUGHT THIS. It passed locally (this machine's username really is
      // `User`) and failed on a runner whose username differs — exactly the
      // environment-dependent green the hostile fixtures exist to stop.
      // Redacting `C:\Users\<name>\` to `C:\Users\<user>\` is the correct
      // outcome: the name is gone, and the scaffolding is not a leak.
      if (identity.id !== 'common-word') {
        expect(out, 'the engine log shipped the identity').not.toContain(identity.username)
      }
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
      deviceLabels: ["Nir Tsur's AirPods", 'Realtek HD Audio'],
      tier1Enabled: true,
      denoiseStrength: 'medium'
    })
    // CONTROL: the raw builder output really does carry both.
    expect(raw).toContain('Nir Tsur')

    // What the zip now writes.
    // createScrubber, not createLocalScrubber: this test simulates a DIFFERENT
    // machine's identity, and createLocalScrubber deliberately binds this one's
    // (its type omits homedir/username for exactly that reason).
    const scrubDocument = createScrubber({
      homedir: 'C:\\Users\\Nir Tsur',
      username: 'Nir Tsur',
      maxLength: Number.MAX_SAFE_INTEGER
    })
    const out = scrubDocument(raw)

    expect(out, 'enginePath shipped the username').not.toContain('C:\\Users\\Nir Tsur')
    // Still useful: the non-identifying half survives.
    expect(out).toContain('Realtek HD Audio')

    // NOT FIXED, and asserted as-is rather than papered over. A device
    // LABEL carries a bare name with no path separator in front of it, and
    // scrub.ts documents that it deliberately never matches a username as a
    // BARE WORD — on this machine the account is literally "User", so a
    // bare-word rule would mangle every sentence containing it. The
    // scrubber therefore cannot catch "Nir Tsur's AirPods", structurally.
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

  // DROPPED IN THIS BACKPORT, DELIBERATELY, AND IT COMES BACK WITH M29.
  // The M29 suite also asserts that support-bundle.ts imports scrubbedCopy
  // rather than re-implementing it — the "one mechanism, both callers" guard.
  // support-bundle.ts is an M29 feature and does not exist on main, so the
  // assertion has nothing to read here and would fail for a reason that says
  // nothing about this fix. It is NOT deleted upstream: when M29 merges, that
  // file arrives and this case must come back with it, or the second caller
  // ships unguarded. Recorded here rather than dropped silently, because a
  // test that quietly disappears in a backport is how a guard gets lost.

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
