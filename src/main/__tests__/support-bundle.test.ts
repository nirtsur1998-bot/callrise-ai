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

const { buildSupportBundle, BUNDLE_FILES, BUNDLE_CONTENT_KINDS, PERMITTED_KINDS, BUNDLE_CLAIM } =
  await import('../support-bundle')

const POISON_EMAIL = 'danawhitfield1998@example.com'
const POISON_PATH = 'C:\\Users\\User\\Desktop\\callrise-ai\\private-note.txt'
const POISON_TRANSCRIPT = "customer said their card is 4111 1111 1111 1111 don't tell anyone"
const POISON_DETAIL = 'OpenAI returned invalid_request: prompt contains banned phrase XYZZY-SECRET'
const POISON_CALL_ID = 'call-01J8ZQ7XYZZYCALLID'

function bundleFiles(dest: string): Set<string> {
  return new Set(readdirSync(dest))
}

/** A real Sales Brain database, poisoned in every way the sweep record's
 *  whitelist is meant to survive. Written with better-sqlite3 so the bundle's
 *  reader opens a genuine database rather than failing and reporting nothing. */
function plantPoisonedBrainDb(dbPath: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3')
  const db = new Database(dbPath)
  try {
    db.exec('CREATE TABLE memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, statement TEXT)')
    db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?)').run(
      'bug215.quoteSweep',
      JSON.stringify({
        status: 'ran',
        at: '2026-09-08T08:54:52.846Z',
        callsSwept: 25,
        memoriesTouched: 36,
        quotesRedacted: 43,
        charactersRemoved: 2537,
        memoriesTotal: 73,
        rescuedByFileCheck: 0,
        // keys no version has ever written — the future-version hazard
        lastQuote: POISON_TRANSCRIPT,
        lastCallId: 'call-2026-09-01-abc123',
        lastError: `ENOENT: open '${POISON_PATH}'`
      })
    )
    // The neighbour. Its reason CAN carry an absolute path and a call id, and
    // anything scoped to "the meta table" rather than to one key takes it along.
    db.prepare('INSERT INTO memory_meta (key, value) VALUES (?, ?)').run(
      'temporal_backfill',
      JSON.stringify({ status: 'skipped', reason: `could not read ${POISON_PATH}`, callId: 'call-xyz' })
    )
    db.prepare('INSERT INTO memories (id, statement) VALUES (?, ?)').run('m1', POISON_TRANSCRIPT)
    db.prepare('INSERT INTO memories (id, statement) VALUES (?, ?)').run('m2', 'sqlite poison')
  } finally {
    db.close()
  }
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

  // M37 — the BUG-D trap's line. It is key=value numbers only by construction
  // (bugd-trap.test.ts pins that it never carries a transcript word), but the
  // POISON_PATH here proves the bundle still scrubs it like every other file
  // rather than trusting that construction.
  writeFileSync(
    join(userDataDir, 'session-health.log'),
    `2026-09-07T00:00:00.000Z session=1 multichannel=true socketOpens=2 serverChannels=2 closeCode=1000 path=${POISON_PATH}
`
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

  // BUG-225 — the cue latency log. Two calls so the summary has something to
  // pool, and a call id that IS an identifier so "ids stay on the device" is a
  // testable claim rather than a description of a file that had none.
  writeFileSync(
    join(userDataDir, 'cue-latency.jsonl'),
    `${JSON.stringify({
      ts: '2026-09-09T10:00:00.000Z',
      callId: POISON_CALL_ID,
      samples: { deterministic: [380, 410, 445], model: [1900, 2400] }
    })}\n${JSON.stringify({
      ts: '2026-09-09T11:00:00.000Z',
      callId: 'call-002',
      samples: { deterministic: [395], model: [2100, 9800] }
    })}\n`
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

  // M37 — memory.db is now READ (counts only, whitelisted), so planting the
  // literal string 'sqlite poison' would no longer exercise anything: the
  // reader would fail to open it, report "could not be read", and the
  // whitelist would never run. A REAL database carrying REAL poison is what
  // makes the guard testable.
  //
  // Poisoned four separate ways, each a hazard someone identified rather than
  // one someone imagined:
  //   - unknown keys on the sweep record itself (a later version's fields)
  //   - a `reason` carrying a path and a transcript (the sibling record in the
  //     same source file already interpolates fs errors into its own reason)
  //   - the NEIGHBOURING temporal_backfill row, whose reason can legitimately
  //     carry an absolute path and a call id
  //   - a memories table holding verbatim buyer speech, plus the original
  //     'sqlite poison' marker so the older assertion still means something
  plantPoisonedBrainDb(join(userDataDir, 'memory.db'))
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
  // M37 — ENUMERATE THE CONTAINER, do not name the hiding places you know
  // about. The suite checked the poisoned path in ONE produced file
  // (kern_bridge.log). Every other file was covered only by whichever
  // assertion someone remembered to write, so a file added to the bundle
  // later — session-health.log was, in M37 — inherited no scrubbing check at
  // all. This walks whatever the bundle actually produced, so a new file is
  // covered on the day it is added rather than the day someone notices.
  it('NO file the bundle produces contains the poisoned path, whatever the file set is', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const names = [...bundleFiles(r.path!)]
    expect(names.length, 'the bundle produced nothing — this test would pass vacuously').toBeGreaterThan(5)
    const leaked = names.filter((n) => readFileSync(join(r.path!, n), 'utf8').includes(POISON_PATH))
    expect(leaked, 'these bundle files carry an unscrubbed filesystem path').toEqual([])
  })

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

  // M37 — the ramp criterion, made observable. Paired: the counts a support
  // reader needs must SURVIVE, and everything else in that database must not.
  // Either assertion alone is satisfiable by a bug (emit nothing / emit all).
  it('the sweep record reaches the bundle with its counts intact', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    const doc = JSON.parse(readFileSync(join(r.path!, 'sales-brain-sweep.json'), 'utf8'))
    expect(doc.quoteSweep).toEqual({
      status: 'ran',
      at: '2026-09-08T08:54:52.846Z',
      callsSwept: 25,
      memoriesTouched: 36,
      quotesRedacted: 43,
      charactersRemoved: 2537,
      memoriesTotal: 73,
      rescuedByFileCheck: 0,
      unknownKeysDropped: 3
    })
  })

  it('and nothing else from that database reaches it', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const all = bundleText(r.path!)
    // the future-version keys on the record itself
    expect(all).not.toContain('call-2026-09-01-abc123')
    expect(all).not.toContain('lastQuote')
    // the neighbouring temporal_backfill row
    expect(all).not.toContain('call-xyz')
    expect(all).not.toContain('temporal_backfill')
    // memory content
    expect(all).not.toContain(POISON_TRANSCRIPT)
    expect(all).not.toContain('sqlite poison')
    // and the path, which the whole-bundle path sweep also covers
    expect(all).not.toContain(POISON_PATH)
  })

  it('the summary says what the number MEANS, not just what it is', async () => {
    // The founder's condition: someone reading it cold must know a non-zero is
    // a problem rather than a statistic.
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const summary = readFileSync(join(r.path!, 'support-summary.txt'), 'utf8')
    expect(summary).toContain('== sales brain quote sweep ==')
    expect(summary).toContain('rescuedByFileCheck should be 0')
    expect(summary).toContain('healthy result')
  })

  it('a machine with no Sales Brain still gets the file, saying so', async () => {
    const r = await buildSupportBundle(src(), downloadsDir)
    const doc = JSON.parse(readFileSync(join(r.path!, 'sales-brain-sweep.json'), 'utf8'))
    expect(doc.quoteSweep).toBeNull()
    expect(doc.meaning).toContain('has not created a memory database')
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

  it('BUG-225 — cue latency leaves as percentiles, and the call ids stay home', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const raw = readFileSync(join(r.path!, 'cue-latency-summary.json'), 'utf8')

    // Asserted against the WHOLE serialised file, not against the summariser's
    // return value: the thing that can go wrong here is the bundle writing a
    // different object than the one the unit test checked. BUG-209's lesson —
    // eleven green tests that would all have stayed green with the call gone.
    expect(raw).not.toContain(POISON_CALL_ID)
    expect(raw).not.toContain('call-002')
    expect(raw).not.toContain('samples') // the raw arrays never leave

    const s = JSON.parse(raw)
    expect(s.calls).toBe(2)
    // Pooled across both calls: 4 deterministic samples, 4 model samples. A
    // per-call average would have reported neither of these.
    expect(s.deterministic).toMatchObject({ calls: 2, count: 4, p50: 395, max: 445 })
    expect(s.model).toMatchObject({ calls: 2, count: 4, p50: 2100, max: 9800 })
    // Every published number is one that genuinely occurred.
    for (const v of [s.deterministic.p50, s.deterministic.p95, s.model.p50, s.model.p95])
      expect([380, 410, 445, 395, 1900, 2400, 2100, 9800]).toContain(v)
  })

  it('BUG-225 — an empty log says so, rather than reporting healthy zeros', async () => {
    const r = await buildSupportBundle(src(), downloadsDir)
    const s = JSON.parse(readFileSync(join(r.path!, 'cue-latency-summary.json'), 'utf8'))
    expect(s).toMatchObject({ calls: 0, deterministic: { count: 0, p50: null }, model: { p95: null } })
    expect(s.meaning).toContain('absence of data')
  })

  it('missing sources are skipped, never fatal — a fresh install still gets a bundle', async () => {
    const r = await buildSupportBundle(src(), downloadsDir)
    expect(r.ok).toBe(true)
    // sales-brain-sweep.json, jobs-summary.json and cue-latency-summary.json
    // are written UNCONDITIONALLY: "the sweep has not run on this machine" and
    // "no call with cues has ended here" are themselves the answers a support
    // reader needs, and an absent file would read as an absent feature.
    expect(bundleFiles(r.path!)).toEqual(
      new Set([
        'support-summary.txt',
        'jobs-summary.json',
        'sales-brain-sweep.json',
        'cue-latency-summary.json'
      ])
    )
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

// M37 — THE CLOSING CLAIM, BOUND TO THE FILE SET.
//
// "This bundle contains NO transcripts, recordings, memories, contacts, deals,
// API keys, or account data" is a NEGATIVE claim about a GROWING container.
// It was written when the bundle held nine files and is falsified not by the
// person who wrote it but by whoever adds the next one — who has no reason to
// re-read a sentence that has been correct for months. This milestone shipped
// ten false locality claims that started exactly that way.
//
// The founder: "A negative claim about a growing container is a claim that
// gets falsified by someone else's commit." So these tests make adding to the
// bundle turn red and ask for the sentence, rather than trusting a re-read.
describe('the closing claim cannot quietly stop being true', () => {
  it('every bundle file declares what kind of thing it carries', () => {
    expect(
      new Set(Object.keys(BUNDLE_CONTENT_KINDS)),
      'a file was added to BUNDLE_FILES without declaring its content kind. Declare it in ' +
        'BUNDLE_CONTENT_KINDS — and while you are there, RE-READ the closing claim rendered from ' +
        'BUNDLE_CLAIM, because that sentence is what your new file has to remain true against.'
    ).toEqual(new Set(BUNDLE_FILES))
  })

  it('every declared kind is one the claim survives', () => {
    for (const [file, kind] of Object.entries(BUNDLE_CONTENT_KINDS)) {
      expect(
        PERMITTED_KINDS as readonly string[],
        `${file} declares kind "${kind}", which the closing claim does not cover. ` +
          'If that is deliberate, the SENTENCE changes — do not widen PERMITTED_KINDS to make ' +
          'this pass, because the sentence is the promise and the list is only its bookkeeping.'
      ).toContain(kind)
    }
  })

  it('the claim the user reads is the claim the tests guard', () => {
    // Rendered from the constant, so prose and pin cannot become two things.
    expect(BUNDLE_CLAIM.join(' ')).toBe(
      'This bundle contains NO transcripts, recordings, memories, contacts, ' +
        'deals, API keys, or account data. Every file passed a scrubber that ' +
        'removes user paths, keys, emails, and ids on the way in.'
    )
  })

  it('and it actually reaches the produced summary', async () => {
    plantAllSources()
    const r = await buildSupportBundle(src(), downloadsDir)
    const summary = readFileSync(join(r.path!, 'support-summary.txt'), 'utf8')
    for (const line of BUNDLE_CLAIM) expect(summary).toContain(line)
  })
})
