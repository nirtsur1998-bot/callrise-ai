// M27 — Tier 1 diagnostics export. The property under test is the PRIVACY
// claim as much as the mechanics: the collected set is exactly the enumerated
// engine files plus one app-built JSON, and nothing else is ever read. A
// support feature that quietly grew an extra input would invalidate the
// card's "no call audio, recordings or transcripts" copy without anyone
// noticing — so the input list is pinned by test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.3.2-test',
    getPath: () => 'C:\\Users\\x\\Downloads'
  },
  BrowserWindow: { getFocusedWindow: () => ({}), getAllWindows: () => [{}] },
  dialog: {
    showSaveDialog: vi.fn(async () => saveDialogResult)
  },
  ipcMain: { handle: vi.fn() }
}))

let saveDialogResult: { canceled: boolean; filePath?: string } = {
  canceled: false,
  filePath: 'C:\\out\\diag.zip'
}

const copied: Array<{ from: string; to: string }> = []
let existingFiles = new Set<string>()
let writtenJson: string | null = null
/** Set by the readFileSync stub so writeFileSync can report the (from,to) pair. */
let lastRead = ''

// BUG-094 changed HOW the engine files are collected: a raw `copyFileSync`
// shipped kern_bridge.log byte-for-byte, so the copy now goes through the
// shared `scrubbedCopy` (read -> scrub every line -> write). This test's
// property is unchanged — only existing files are collected, a missing one is
// skipped rather than fatal — it just observes that through the mechanism
// actually in use.
//
// ONE factory for both specifiers: vitest resolves `fs` and `node:fs` to the
// same module, so two separate vi.mock calls do not compose — the second wins
// and the first one's exports vanish ("No \"mkdirSync\" export is defined").
// tier1-diagnostics imports from 'fs'; scrubbed-copy imports from 'node:fs'.
// A function DECLARATION, not a const arrow: vi.mock calls are hoisted above
// the module body, so a const factory hits the temporal dead zone
// ("Cannot access fsMock before initialization"). Declarations hoist with them.
function fsMock(): Record<string, unknown> {
  return {
  existsSync: (p: string) => existingFiles.has(p),
  readFileSync: (p: string) => {
    lastRead = p
    return `line from ${p}\n`
  },
  writeFileSync: (to: string, content: string) => {
    // app-diagnostics.json is built in-module and written directly; the engine
    // files arrive via scrubbedCopy, which reads first.
    if (to.endsWith('app-diagnostics.json')) writtenJson = content
    else copied.push({ from: lastRead, to })
  },
    mkdirSync: vi.fn(),
    rmSync: vi.fn()
  }
}
vi.mock('fs', fsMock)
vi.mock('node:fs', fsMock)

let execFileArgs: { cmd: string; args: string[]; env: Record<string, string | undefined> } | null =
  null
let execFileShouldFail = false
vi.mock('child_process', () => ({
  execFile: (
    cmd: string,
    args: string[],
    opts: { env: Record<string, string | undefined> },
    cb: (err: Error | null) => void
  ) => {
    execFileArgs = { cmd, args, env: opts.env }
    cb(execFileShouldFail ? new Error('Compress-Archive blew up') : null)
  }
}))

// The diagnostics module imports getStatus from ./tier1 — stub it so this
// file doesn't drag the whole pipe client in.
vi.mock('../tier1', () => ({
  getStatus: () => ({
    engineAvailable: true,
    engineRunning: false,
    connected: false,
    denoisingActive: null,
    enginePath: 'C:\\x\\kern_bridge.exe'
  })
}))

const { engineDiagnosticFiles, buildAppDiagnostics, exportTier1Diagnostics } =
  await import('../tier1-diagnostics')

beforeEach(() => {
  process.env['LOCALAPPDATA'] = 'C:\\Users\\x\\AppData\\Local'
  saveDialogResult = { canceled: false, filePath: 'C:\\out\\diag.zip' }
  copied.length = 0
  existingFiles = new Set()
  writtenJson = null
  execFileArgs = null
  execFileShouldFail = false
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the collected set is enumerated, pinned, and nothing more', () => {
  it('lists exactly the two engine logs and the status sidecar', () => {
    const files = engineDiagnosticFiles('C:\\Users\\x\\AppData\\Local')
    expect(files).toEqual([
      'C:\\Users\\x\\AppData\\Local\\CallRiseAI\\logs\\kern_bridge.log',
      'C:\\Users\\x\\AppData\\Local\\CallRiseAI\\logs\\kern_bridge.log.1',
      'C:\\Users\\x\\AppData\\Local\\CallRiseAI\\kern_bridge_status.json'
    ])
  })

  it('copies only files that exist — a missing log is skipped, not fatal', async () => {
    existingFiles.add('C:\\Users\\x\\AppData\\Local\\CallRiseAI\\logs\\kern_bridge.log')
    const res = await exportTier1Diagnostics({})
    expect(res.ok).toBe(true)
    expect(copied.map((c) => c.from)).toEqual([
      'C:\\Users\\x\\AppData\\Local\\CallRiseAI\\logs\\kern_bridge.log'
    ])
  })
})

describe('app-diagnostics.json', () => {
  it('carries version, tier1 status, prefs and a device CLASSIFICATION — never a label (BUG-122)', () => {
    const json = JSON.parse(
      buildAppDiagnostics({
        devices: { hasVirtualMic: true, inputCount: 2, kinds: ['bluetooth', 'virtual'] },
        tier1Enabled: true,
        denoiseStrength: 'medium'
      })
    ) as Record<string, unknown>
    expect(json['appVersion']).toBe('1.3.2-test')
    expect(json['tier1Enabled']).toBe(true)
    expect(json['denoiseStrength']).toBe('medium')
    expect(json['devices']).toEqual({ hasVirtualMic: true, inputCount: 2, kinds: ['bluetooth', 'virtual'] })
    expect(json).not.toHaveProperty('deviceLabels')
    expect(json['tier1Status']).toMatchObject({ engineAvailable: true })
  })

  it('a renderer payload that smuggles labels or junk kinds is re-validated on the main side', () => {
    const json = JSON.parse(
      buildAppDiagnostics({
        devices: { hasVirtualMic: 'yes', inputCount: 2.7, kinds: ['bluetooth', "Dana's AirPods", 42] }
      } as unknown as Parameters<typeof buildAppDiagnostics>[0])
    ) as Record<string, unknown>
    expect(json['devices']).toEqual({ hasVirtualMic: false, inputCount: 2, kinds: ['bluetooth'] })
    expect(JSON.stringify(json)).not.toContain('AirPods')
  })
})

describe('export flow', () => {
  it('cancelled save dialog returns canceled, touches nothing', async () => {
    saveDialogResult = { canceled: true }
    const res = await exportTier1Diagnostics({})
    expect(res).toEqual({ ok: false, canceled: true })
    expect(copied).toHaveLength(0)
    expect(execFileArgs).toBeNull()
  })

  it('passes paths to PowerShell via ENVIRONMENT, never interpolated into the command', async () => {
    await exportTier1Diagnostics({})
    expect(execFileArgs).not.toBeNull()
    const command = execFileArgs!.args.join(' ')
    // The command string references env vars only — the actual paths must
    // not appear in it, or a hostile filename becomes PowerShell syntax.
    expect(command).toContain('$env:CR_DIAG_SRC')
    expect(command).toContain('$env:CR_DIAG_DEST')
    expect(command).not.toContain('C:\\out\\diag.zip')
    expect(execFileArgs!.env['CR_DIAG_DEST']).toBe('C:\\out\\diag.zip')
  })

  it('a Compress-Archive failure surfaces as an error, not a fake success', async () => {
    execFileShouldFail = true
    const res = await exportTier1Diagnostics({})
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Compress-Archive')
  })

  it('always writes app-diagnostics.json even when no engine file exists', async () => {
    const res = await exportTier1Diagnostics({ tier1Enabled: false })
    expect(res.ok).toBe(true)
    expect(writtenJson).not.toBeNull()
    // An empty zip would be a support dead-end; the app JSON alone still
    // answers "was it enabled, what did the app think the engine state was".
    expect((JSON.parse(writtenJson!) as Record<string, unknown>)['tier1Enabled']).toBe(false)
  })
})
