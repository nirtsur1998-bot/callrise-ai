// M29 A1.6 — THE PRIVACY RED-CHECK SUITE. Runnable forever after.
//
// The milestone's prime directive, as assertions against the real code with a
// real intercepted fetch and a real temp userData directory that carries a
// planted account (supabase-auth.json) and a planted updater id:
//
//   1. A transcript string planted in an error path NEVER appears in any
//      outbound payload.
//   2. Opt-out (and never-asked) sends ZERO bytes.
//   3. The telemetry id cannot be joined to the account: the request carries
//      the anon key and no user token; the body has no user id, no email, no
//      updater id; no telemetry file on disk contains the email.
//   4. Structurally: the telemetry module has no code path to auth, settings,
//      backup, supabase-js, or the updater id.
//
// Each negative assertion is paired with a control proving the planted value
// really was present upstream, so none of these can pass vacuously. The
// red-checks (break the scrubber / the gate / the transport and watch the
// matching test fail) are recorded in docs/M29-A1-plan.md.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureError } from '../capture'
import { setConsent } from '../consent'
import { flushTelemetry, resetFlushState, setIngestConfig } from '../flush'
import { listQueued, record, resetTelemetry } from '../index'
import { recordLaunch, recordQuit, setupTelemetry } from '../setup'

const TRANSCRIPT = 'Buyer said: our budget is forty thousand and the CFO is Dana'
const EMAIL = 'nir.tsur.real@gmail.com'
const ACCOUNT_ID = 'acc0un7-1d00-4000-8000-000000000001'
const UPDATER_ID = 'e8328791-a06e-5af3-bd54-a1995b9c350b'
const SESSION_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhY2MwdW43LTFkMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMSIsImVtYWlsIjoibmlyLnRzdXIucmVhbEBnbWFpbC5jb20ifQ.sessionsignature'
const ANON_KEY = 'public-anon-key'
const CFG = { url: 'https://proj.supabase.co', anonKey: ANON_KEY }

let dir: string
let requests: Array<{ url: string; headers: Record<string, string>; body: string }>
const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
  requests.push({
    url: String(url),
    headers: { ...((init?.headers as Record<string, string>) ?? {}) },
    body: String(init?.body ?? '')
  })
  return new Response(null, { status: 201 })
})
const fetchImpl = fetchMock as unknown as typeof fetch

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-privacy-'))
  requests = []
  fetchMock.mockClear()
  resetFlushState()
  // Plant the account exactly where the real app keeps it, plus the updater id.
  await writeFile(
    join(dir, 'supabase-auth.json'),
    JSON.stringify({
      'sb-proj-auth-token': {
        access_token: SESSION_JWT,
        user: { id: ACCOUNT_ID, email: EMAIL, user_metadata: { full_name: 'Nir Tsur' } }
      }
    })
  )
  await writeFile(join(dir, '.updaterId'), UPDATER_ID)
  setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: join(dir, 'dumps') })
  setIngestConfig(() => CFG)
})
afterEach(async () => {
  resetTelemetry()
  resetFlushState()
  await rm(dir, { recursive: true, force: true })
})

function plantedError(): Error {
  const err = new Error(`Summary failed — ${TRANSCRIPT} — for ${EMAIL}`)
  err.stack = [
    `Error: Summary failed — ${TRANSCRIPT} — for ${EMAIL}`,
    `    at summarize (C:\\Users\\nirtsur\\AppData\\Local\\Programs\\CallRiseAI\\resources\\app.asar\\out\\main\\index.js:10:5)`
  ].join('\n')
  return err
}

describe('1. a transcript planted in an error path never leaves', () => {
  it('through captureError → queue → flush, the outbound body has the class and frames and no transcript', async () => {
    setConsent(dir, 'on')
    const err = plantedError()
    expect(err.stack).toContain(TRANSCRIPT) // control
    captureError('main:uncaughtException', err)
    // and a caller who (wrongly) tries to put content in a prop:
    record('error', 'error.summary', { note: TRANSCRIPT, stack: err.stack ?? '' })

    const queuedText = JSON.stringify(listQueued())
    expect(queuedText).not.toContain(TRANSCRIPT)
    expect(queuedText).not.toContain('forty thousand')

    const r = await flushTelemetry({ fetchImpl })
    expect(r.sent).toBeGreaterThan(0) // control: something really went out
    expect(requests).toHaveLength(1)
    const body = requests[0].body
    expect(body).toContain('error.main-uncaughtexception') // control: the error event is in the body
    expect(body).toContain('at summarize (') // the frame survived
    expect(body).not.toContain(TRANSCRIPT)
    expect(body).not.toContain('forty thousand')
    expect(body).not.toContain('Dana')
    expect(body).not.toContain('nirtsur') // the username in the path
  })
})

describe('2. opt-out sends zero bytes', () => {
  it.each(['unasked', 'off'] as const)(
    'with consent %s: a full launch → capture → flush → quit cycle makes no request and writes no telemetry file',
    async (state) => {
      if (state === 'off') setConsent(dir, 'off')
      recordLaunch()
      captureError('main:uncaughtException', plantedError())
      record('usage', 'feature.rise.opened')
      record('crash', 'crash.renderer', { reason: 'oom' })
      const r = await flushTelemetry({ fetchImpl })
      recordQuit()

      expect(r.attempted).toBe(false)
      expect(requests).toHaveLength(0)
      expect(fetchMock).not.toHaveBeenCalled()
      const files = (await readdir(dir)).sort()
      // Only the planted account files, plus (for 'off') the decision itself.
      expect(files).toEqual(
        state === 'off'
          ? ['.updaterId', 'supabase-auth.json', 'telemetry-consent.json']
          : ['.updaterId', 'supabase-auth.json']
      )
    }
  )

  it('turning off after opting in stops the very next flush and deletes the queue and id', async () => {
    setConsent(dir, 'on')
    record('usage', 'feature.rise.opened')
    setConsent(dir, 'off')
    expect((await flushTelemetry({ fetchImpl })).attempted).toBe(false)
    expect(requests).toHaveLength(0)
    expect(existsSync(join(dir, 'telemetry-queue.jsonl'))).toBe(false)
    expect(existsSync(join(dir, 'telemetry-id'))).toBe(false)
  })
})

describe('3. the telemetry id cannot be joined to the account', () => {
  it('the request carries the PUBLIC anon key and never the session token; the body carries no account, email, or updater id', async () => {
    setConsent(dir, 'on')
    record('usage', 'feature.rise.opened')
    expect((await flushTelemetry({ fetchImpl })).sent).toBeGreaterThan(0)
    const [req] = requests
    expect(req.headers.apikey).toBe(ANON_KEY)
    expect(req.headers.Authorization).toBe(`Bearer ${ANON_KEY}`)
    expect(req.headers.Authorization).not.toContain(SESSION_JWT)
    expect(Object.keys(req.headers).map((h) => h.toLowerCase())).not.toContain('cookie')
    expect(req.body).not.toContain(EMAIL)
    expect(req.body).not.toContain(ACCOUNT_ID)
    expect(req.body).not.toContain(UPDATER_ID)
    expect(req.body).not.toContain('user_id')
    expect(req.body).not.toContain('Nir Tsur')
    // RPC parameter shape: { rows: [...] }, not a bare array (transport.ts
    // targets telemetry_ingest_batch, not a direct table insert).
    const rows = (JSON.parse(req.body) as { rows: Array<Record<string, unknown>> }).rows
    expect(rows[0].anon_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(rows[0].anon_id).not.toBe(UPDATER_ID)
    expect(rows[0].anon_id).not.toBe(ACCOUNT_ID)
  })

  it('no telemetry file on disk contains the email, the account id, or the updater id', async () => {
    setConsent(dir, 'on')
    captureError('main:uncaughtException', plantedError())
    await flushTelemetry({ fetchImpl })
    const telemetryFiles = (await readdir(dir)).filter((f) => f.startsWith('telemetry'))
    expect(telemetryFiles.length).toBeGreaterThanOrEqual(3) // id, consent, sent log (queue is drained)
    for (const f of telemetryFiles) {
      const text = await readFile(join(dir, f), 'utf8')
      expect(text, f).not.toContain(EMAIL)
      expect(text, f).not.toContain(ACCOUNT_ID)
      expect(text, f).not.toContain(UPDATER_ID)
      expect(text, f).not.toContain(TRANSCRIPT)
    }
    // and the account file was never touched by telemetry
    expect(await readFile(join(dir, 'supabase-auth.json'), 'utf8')).toContain(EMAIL) // control: still there, unchanged
  })

  it('the anonymous id is different on every fresh consent — no durable identifier across opt-out', () => {
    setConsent(dir, 'on')
    const a = readFileSync(join(dir, 'telemetry-id'), 'utf8').trim()
    setConsent(dir, 'off')
    setConsent(dir, 'on')
    const b = readFileSync(join(dir, 'telemetry-id'), 'utf8').trim()
    expect(a).not.toBe(b)
  })
})

describe('4. structural — no code path from telemetry to identity', () => {
  // DERIVED, never hand-listed. This was a literal array of 13 filenames until
  // 2026-08-24, by which point the directory held 14: `signals.ts` (added in
  // A2, after this suite was written) was silently unchecked. The guarantee
  // happened to still hold — reading all 14 files' imports found nothing
  // reaching identity — but nothing was keeping it true, and a list that must
  // be updated by hand is a guard that falls behind by default.
  //
  // Same structural principle as deriving the renderer's syncScope union from
  // `keyof BackupSyncScope` instead of retyping it: if the set can drift, the
  // set must be computed.
  const MODULE_DIR = join(__dirname, '..')
  const MODULE_FILES = readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.ts'))
    .sort()

  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('the derived file list actually found the module (a vacuous loop would pass everything)', () => {
    // Without this, deleting the module or breaking the glob would make every
    // assertion below iterate zero times and report green.
    expect(MODULE_FILES.length).toBeGreaterThanOrEqual(14)
    expect(MODULE_FILES).toContain('signals.ts') // the file the hand-list forgot
    expect(MODULE_FILES).toContain('scrub.ts')
  })

  it('no telemetry file imports auth, app-settings, backup, supabase-js, or electron-updater', () => {
    for (const f of MODULE_FILES) {
      const src = stripComments(readFileSync(join(__dirname, '..', f), 'utf8'))
      expect(src, f).not.toMatch(/from '\.\.\/auth'/)
      expect(src, f).not.toMatch(/from '\.\.\/app-settings'/)
      expect(src, f).not.toMatch(/from '\.\.\/backup/)
      expect(src, f).not.toMatch(/@supabase\/supabase-js/)
      expect(src, f).not.toMatch(/electron-updater/)
      expect(src, f).not.toMatch(/updaterId/)
      expect(src, f).not.toMatch(/supabase-auth/)
    }
    // Only ipc.ts may import electron at all.
    for (const f of MODULE_FILES.filter((x) => x !== 'ipc.ts')) {
      const src = stripComments(readFileSync(join(__dirname, '..', f), 'utf8'))
      expect(src, f).not.toMatch(/from 'electron'/)
    }
  })

  it('consent is not part of AppSettings, so it is never in the cloud-backup payload', () => {
    // Refined for A2: backup.ts and app-settings.ts MAY import the outbound
    // signal catalog (./telemetry/signals — consent-gated counters out).
    // What they must never touch is the consent/id machinery itself: a
    // consent value in AppSettings would ride the backup payload into the
    // account's cloud row, which is the join this test exists to prevent.
    for (const f of ['app-settings.ts', 'backup.ts']) {
      const src = stripComments(readFileSync(join(__dirname, '..', '..', f), 'utf8'))
      expect(src, f).not.toMatch(/telemetryConsent/)
      expect(src, f).not.toMatch(/telemetry-consent/)
      expect(src, f).not.toMatch(/from '\.\/telemetry\/consent'/)
      expect(src, f).not.toMatch(/from '\.\/telemetry\/anon-id'/)
      expect(src, f).not.toMatch(/from '\.\/telemetry\/index'/)
      expect(src, f).not.toMatch(/from '\.\/telemetry'$/m)
    }
  })

  it('nothing outside the telemetry module writes its consent, id, queue or sent-log files', () => {
    const mainDir = join(__dirname, '..', '..')
    const offenders: string[] = []
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (name === 'telemetry' || name === '__tests__' || name === 'node_modules') continue
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.ts$/.test(name)) {
          const src = stripComments(readFileSync(p, 'utf8'))
          if (/telemetry-(consent|id|queue|sent)/.test(src)) offenders.push(p)
        }
      }
    }
    walk(mainDir)
    expect(offenders).toEqual([])
  })
})
