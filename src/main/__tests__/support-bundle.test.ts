// M29 A5.4 — the support bundle: one click, a dated folder in Downloads, a
// readable summary the founder can be emailed. This is a privacy-pin suite
// in the tier1-diagnostics/A1-privacy-suite style: plant poison in every
// source the bundle reads, prove the poison really is IN the source (the
// control), then prove it is ABSENT from every file the bundle produces.
// "Judge the code, not the comments" — poison is checked against actual
// bundle bytes, not against what the code claims to strip.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir: string
let localAppDataDir: string
let downloadsDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'downloads' ? downloadsDir : userDataDir),
    getAppPath: () => userDataDir,
    getVersion: () => '1.9.9'
  },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))
// Kept off the electron-updater/job-manager import graph deliberately — the
// summary line only needs a status shape, not a live updater.
vi.mock('../updater/index', () => ({ updateStatus: () => ({ state: 'idle' }) }))

const { buildSupportBundle, BUNDLE_FILES } = await import('../support-bundle')

const POISON_EMAIL = 'danawhitfield1998@example.com'
const POISON_PATH = 'C:\\Users\\User\\Desktop\\callrise-ai\\private-note.txt'
const POISON_TRANSCRIPT = "customer said their card is 4111 1111 1111 1111 don't tell anyone"
const POISON_DETAIL = 'OpenAI returned invalid_request: prompt contains banned phrase XYZZY-SECRET'

function bundleFiles(dest: string): Set<string> {
  return new Set(readdirSync(dest))
}

function bundleText(dest: string): string {
  return readdirSync(dest)
    .map((f) => readFileSync(join(dest, f), 'utf8'))
    .join('\n---\n')
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'sb-userdata-'))
  localAppDataDir = mkdtempSync(join(tmpdir(), 'sb-localappdata-'))
  downloadsDir = mkdtempSync(join(tmpdir(), 'sb-downloads-'))
  mkdirSync(join(userDataDir, 'logs'), { recursive: true })
  mkdirSync(join(localAppDataDir, 'CallRiseAI', 'logs'), { recursive: true })
})

afterEach(() => {
  for (const d of [userDataDir, localAppDataDir, downloadsDir]) rmSync(d, { recursive: true, force: true })
})

function src(): { userDataDir: string; localAppData: string; appVersion: string; electronVersion: string } {
  return { userDataDir, localAppData: localAppDataDir, appVersion: '1.9.9', electronVersion: '32.0.0' }
}

/** Plants a poisoned version of every readable source the bundle touches. */
function plantAllSources(): void {
  // App logs — simulate a pre-A1.0b line that still carries a raw path/email.
  writeFileSync(
    join(userDataDir, 'logs', 'callrise.log'),
    `[info] normal line\n[error] failed for ${POISON_PATH} contact ${POISON_EMAIL}\n`
  )
  writeFileSync(join(userDataDir, 'logs', 'callrise.old.log'), `[warn] old line ${POISON_PATH}\n`)

  // AI fallback log — detail carries provider prose, must never leave.
  writeFileSync(
    join(userDataDir, 'ai-fallback-events.jsonl'),
    `${JSON.stringify({
      ts: '2026-08-20T00:00:00.000Z',
      purpose: 'coaching-cue',
      fromCatalogId: 'openai-gpt5',
      toCatalogId: 'google-gemini',
      reason: 'provider-error',
      detail: POISON_DETAIL
    })}\n`
  )

  // Purpose health — lastFailureDetail is the one free-text field.
  writeFileSync(
    join(userDataDir, 'ai-purpose-health.json'),
    JSON.stringify({
      'coaching-cue': {
        consecutiveFailures: 3,
        failureEpisodes: 1,
        firstFailureAt: '2026-08-20T00:00:00.000Z',
        lastFailureAt: '2026-08-20T00:00:00.000Z',
        lastFailureReason: 'auth',
        lastFailureProviderId: 'openai',
        lastFailureDetail: POISON_DETAIL,
        lastFailureClass: null,
        lastFailureResetsAt: null,
        lastSuccessAt: null,
        lastSuccessProviderId: null,
        substitutingSince: null,
        substituteSuccesses: 0,
        substituteProviderId: null
      }
    })
  )

  // Job history — title and resultData can carry call content by design.
  writeFileSync(
    join(userDataDir, 'jobs-state.json'),
    JSON.stringify([
      {
        id: 'job-1',
        type: 'summary',
        title: `Summarize call with ${POISON_EMAIL}`,
        state: 'failed',
        progress: { mode: 'indeterminate' },
        lane: 'BATCH',
        priority: 0,
        createdAt: 1,
        endedAt: 2,
        error: { message: POISON_TRANSCRIPT, code: 'rate-limit' },
        resultData: { transcript: POISON_TRANSCRIPT },
        cancellable: false
      }
    ])
  )

  // Backup state — included whole, but must still pass through scrub().
  writeFileSync(
    join(userDataDir, 'backup-state.json'),
    JSON.stringify({ lastError: `upload failed for ${POISON_PATH} (${POISON_EMAIL})` })
  )

  // kern_bridge engine logs.
  writeFileSync(
    join(localAppDataDir, 'CallRiseAI', 'logs', 'kern_bridge.log'),
    `mic bridge started for ${POISON_PATH}\n`
  )
  writeFileSync(join(localAppDataDir, 'CallRiseAI', 'logs', 'kern_bridge.log.1'), 'previous run ok\n')
  writeFileSync(
    join(localAppDataDir, 'CallRiseAI', 'kern_bridge_status.json'),
    JSON.stringify({ pid: 1, modelLoaded: true })
  )

  // Files that must NEVER be read or copied, poisoned so a bug would be loud.
  writeFileSync(join(userDataDir, 'memory.db'), 'sqlite poison')
  writeFileSync(join(userDataDir, 'supabase-auth.json'), JSON.stringify({ jwt: POISON_DETAIL }))
  writeFileSync(join(userDataDir, 'ai-keys.json'), JSON.stringify({ openai: 'sk-secret-should-never-ship' }))
  writeFileSync(join(userDataDir, 'app-settings.json'), JSON.stringify({ note: POISON_TRANSCRIPT }))
}

describe('the fixture actually plants poison (the control)', () => {
  it('every source file really contains its poison before the bundle runs', () => {
    plantAllSources()
    expect(readFileSync(join(userDataDir, 'logs', 'callrise.log'), 'utf8')).toContain(POISON_EMAIL)
    expect(readFileSync(join(userDataDir, 'ai-fallback-events.jsonl'), 'utf8')).toContain(POISON_DETAIL)
    expect(readFileSync(join(userDataDir, 'ai-purpose-health.json'), 'utf8')).toContain(POISON_DETAIL)
    expect(readFileSync(join(userDataDir, 'jobs-state.json'), 'utf8')).toContain(POISON_TRANSCRIPT)
    expect(readFileSync(join(userDataDir, 'jobs-state.json'), 'utf8')).toContain(POISON_EMAIL)
    expect(readFileSync(join(userDataDir, 'backup-state.json'), 'utf8')).toContain(POISON_EMAIL)
    expect(readFileSync(join(localAppDataDir, 'CallRiseAI', 'logs', 'kern_bridge.log'), 'utf8')).toContain(
      POISON_PATH
    )
  })
})

describe('buildSupportBundle — privacy pin', () => {
  it('the produced file set is exactly the closed allowlist, nothing more', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    expect(r.ok).toBe(true)
    expect(bundleFiles(r.path!)).toEqual(new Set(BUNDLE_FILES))
  })

  it('never-include files leave no trace by name or content anywhere in the bundle', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const files = bundleFiles(r.path!)
    for (const forbidden of ['memory.db', 'supabase-auth.json', 'ai-keys.json', 'app-settings.json']) {
      expect(files.has(forbidden)).toBe(false)
    }
    const all = bundleText(r.path!)
    expect(all).not.toContain('sqlite poison')
    expect(all).not.toContain('sk-secret-should-never-ship')
  })

  it('the fallback log detail field is stripped, not merely scrubbed', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const jsonl = readFileSync(join(r.path!, 'ai-fallback-events.jsonl'), 'utf8')
    expect(jsonl).not.toContain(POISON_DETAIL)
    expect(jsonl).not.toContain('XYZZY-SECRET')
    expect(jsonl).toContain('coaching-cue') // the rest of the record survives
    expect(bundleText(r.path!)).not.toContain(POISON_DETAIL)
  })

  it('purpose-health lastFailureDetail is nulled, the rest of the record survives', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const health = JSON.parse(readFileSync(join(r.path!, 'ai-purpose-health.json'), 'utf8'))
    expect(health['coaching-cue'].lastFailureDetail).toBeNull()
    expect(health['coaching-cue'].lastFailureReason).toBe('auth')
    expect(bundleText(r.path!)).not.toContain(POISON_DETAIL)
  })

  it('job history is metadata only — no title, no resultData, no error message text', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const jobs = JSON.parse(readFileSync(join(r.path!, 'jobs-summary.json'), 'utf8'))
    expect(jobs).toEqual([
      { id: 'job-1', type: 'summary', state: 'failed', lane: 'BATCH', errorCode: 'rate-limit', createdAt: 1, endedAt: 2 }
    ])
    const all = bundleText(r.path!)
    expect(all).not.toContain(POISON_TRANSCRIPT)
    expect(all).not.toContain(POISON_EMAIL)
  })

  it('old log lines predating write-time scrubbing are scrubbed on copy', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const log = readFileSync(join(r.path!, 'callrise.log'), 'utf8')
    expect(log).not.toContain(POISON_EMAIL)
    expect(log).not.toContain('\\User\\')
    expect(log).toContain('<email>')
    const old = readFileSync(join(r.path!, 'callrise.old.log'), 'utf8')
    expect(old).not.toContain('\\User\\')
  })

  it('kern_bridge engine logs are scrubbed on copy, reusing tier1-diagnostics\u2019 own file list', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const kern = readFileSync(join(r.path!, 'kern_bridge.log'), 'utf8')
    expect(kern).not.toContain(POISON_PATH)
    expect(kern).not.toContain('\\User\\')
    expect(kern).toMatch(/<home>|<user>/)
  })

  it('backup state is included in full but still passes through the scrubber', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const summary = readFileSync(join(r.path!, 'support-summary.txt'), 'utf8')
    expect(summary).not.toContain(POISON_EMAIL)
    expect(summary).toContain('<email>')
  })

  it('missing sources are skipped, never fatal — a fresh install still gets a bundle', async () => {
    const r = await buildSupportBundle(src(), downloadsDir)
    expect(r.ok).toBe(true)
    expect(bundleFiles(r.path!)).toEqual(new Set(['support-summary.txt', 'jobs-summary.json']))
  })

  it('a second run the same day gets a suffixed folder, not an overwrite', async () => {
    plantAllSources()
    const first = await buildSupportBundle(src(), downloadsDir)
    const second = await buildSupportBundle(src(), downloadsDir)
    expect(first.path).not.toBe(second.path)
    expect(second.path).toContain('-2')
  })
})

describe('REAL-SCALE fixtures — the sweep found the old ones an order of magnitude too small', () => {
  // The privacy pin planted ONE purpose (~460 chars) and ONE job (~180), both
  // far under the app-wide scrubber's 4096-char cap, so it could not see that
  // whole documents were being truncated into unparseable JSON. Measured on
  // the founder's live machine: ai-purpose-health 6,297 chars / 13 purposes,
  // jobs-summary 10,779 / 47 jobs. These fixtures are sized like reality.

  const ALL_PURPOSES = [
    'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
    'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
    'memory-consolidate', 'memory-reflect', 'assistant-chat'
  ]

  function plantRealScale(jobCount: number): void {
    const health: Record<string, unknown> = {}
    for (const purpose of ALL_PURPOSES) {
      health[purpose] = {
        consecutiveFailures: 3,
        failureEpisodes: 1,
        firstFailureAt: '2026-08-20T00:00:00.000Z',
        lastFailureAt: '2026-08-20T00:00:00.000Z',
        lastFailureReason: 'rate-limit',
        lastFailureProviderId: 'google',
        lastFailureDetail: POISON_DETAIL,
        lastFailureClass: null,
        lastFailureResetsAt: null,
        lastSuccessAt: null,
        lastSuccessProviderId: null,
        substitutingSince: null,
        substituteSuccesses: 0,
        substituteProviderId: null
      }
    }
    writeFileSync(join(userDataDir, 'ai-purpose-health.json'), JSON.stringify(health))

    const jobs = Array.from({ length: jobCount }, (_, i) => ({
      // Real job ids are v4 UUIDs; a non-UUID id would dodge the scrubber's
      // UUID rule and hide whether ids survive at all.
      id: `0000${String(i).padStart(4, '0')}-aaaa-4bbb-8ccc-ddddeeeeffff`.slice(-36),
      type: 'calls:summarize',
      title: `Summarize call with ${POISON_EMAIL}`,
      state: 'succeeded',
      progress: { mode: 'indeterminate' },
      lane: 'BATCH',
      priority: 0,
      createdAt: i,
      endedAt: i + 1,
      resultData: { transcript: POISON_TRANSCRIPT },
      cancellable: false
    }))
    writeFileSync(join(userDataDir, 'jobs-state.json'), JSON.stringify(jobs))
  }

  it('a full 13-purpose health file survives as VALID JSON with every purpose intact', async () => {
    plantRealScale(0)
    // Control: the source really is over the old 4096 cap.
    expect(readFileSync(join(userDataDir, 'ai-purpose-health.json'), 'utf8').length).toBeGreaterThan(4096)

    const r = await buildSupportBundle(src(), downloadsDir)
    const raw = readFileSync(join(r.path!, 'ai-purpose-health.json'), 'utf8')
    expect(raw).not.toContain('truncated') // no silent cut marker
    const parsed = JSON.parse(raw) // would THROW on the truncated version
    expect(Object.keys(parsed).sort()).toEqual([...ALL_PURPOSES].sort())
    // Still stripped, at scale.
    expect(raw).not.toContain(POISON_DETAIL)
    for (const p of ALL_PURPOSES) expect(parsed[p].lastFailureDetail).toBeNull()
  })

  it('a 47-job history survives as VALID JSON with every row intact', async () => {
    plantRealScale(47)
    expect(readFileSync(join(userDataDir, 'jobs-state.json'), 'utf8').length).toBeGreaterThan(4096)

    const r = await buildSupportBundle(src(), downloadsDir)
    const raw = readFileSync(join(r.path!, 'jobs-summary.json'), 'utf8')
    expect(raw).not.toContain('truncated')
    const rows = JSON.parse(raw) // would THROW on the truncated version
    expect(rows).toHaveLength(47) // the sweep measured 18 of 47 surviving
    // Metadata only, still — at scale.
    expect(raw).not.toContain(POISON_TRANSCRIPT)
    expect(raw).not.toContain(POISON_EMAIL)
  })

  it('the summary itself is not truncated when the sources are large', async () => {
    plantRealScale(47)
    const r = await buildSupportBundle(src(), downloadsDir)
    const summary = readFileSync(join(r.path!, 'support-summary.txt'), 'utf8')
    expect(summary).not.toContain('truncated')
    // The closing privacy statement is the LAST thing in the file, so its
    // presence proves the tail survived.
    expect(summary).toContain('NO transcripts')
  })

  it('the identity rules still apply to whole documents (no cap must not mean no scrubbing)', async () => {
    plantRealScale(5)
    writeFileSync(
      join(userDataDir, 'backup-state.json'),
      JSON.stringify({ lastError: `failed for ${POISON_PATH} (${POISON_EMAIL})` })
    )
    const r = await buildSupportBundle(src(), downloadsDir)
    const summary = readFileSync(join(r.path!, 'support-summary.txt'), 'utf8')
    expect(summary).not.toContain(POISON_EMAIL)
    expect(summary).toContain('<email>')
  })
})

describe("the engine's rotated log is collected under the name the engine actually writes", () => {
  it('kern_bridge.log.1 is picked up and scrubbed', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    expect(bundleFiles(r.path!).has('kern_bridge.log.1')).toBe(true)
  })

  it('the stale name the engine never writes is NOT expected by the shared list', async () => {
    // Pin against the engine's real rotation constant rather than against this
    // module's own expectation — the original bug was a fixture written from
    // the TypeScript instead of cross-checked with the C++ writer.
    const { engineDiagnosticFiles } = await import('../tier1-diagnostics')
    const names = engineDiagnosticFiles('X').map((p) => p.split(/[\\/]/).pop())
    expect(names).toContain('kern_bridge.log.1')
    expect(names).not.toContain('kern_bridge.prev.log')
  })
})
