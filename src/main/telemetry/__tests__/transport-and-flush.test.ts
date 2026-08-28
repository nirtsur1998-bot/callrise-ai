// M29 A1.4 / A1.5 — transport, flush with backoff, and the sent log.
// fetch is injected and recorded; nothing here touches the network.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setConsent } from '../consent'
import { listQueued, record, resetTelemetry } from '../index'
import {
  BACKOFF_MS,
  buildEnvelope,
  flushTelemetry,
  resetFlushState,
  setIngestConfig,
  startTelemetrySchedule,
  stopTelemetrySchedule
} from '../flush'
import { appendSent, clearSent, listSent, listSentRows, sentLogPath } from '../sent-log'
import { applyConsentDecision, setupTelemetry } from '../setup'
import { ingestBody, ingestHeaders, ingestUrl, sendBatch, toRows } from '../transport'

const CFG = { url: 'https://example-project.supabase.co/', anonKey: 'anon-key-for-tests' }

let dir: string
let calls: Array<{ url: string; init: RequestInit }>
let respond: () => Response | Promise<Response>

const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
  calls.push({ url: String(url), init: init ?? {} })
  // Honour the abort signal the way real fetch does, so the timeout path is testable.
  return new Promise<Response>((resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    )
    Promise.resolve()
      .then(() => respond())
      .then(resolve, reject)
  })
})
const fetchImpl = fetchMock as unknown as typeof fetch

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-flush-'))
  calls = []
  respond = () => new Response(null, { status: 201 })
  fetchMock.mockClear()
  resetFlushState()
  setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: join(dir, 'dumps') })
  setIngestConfig(() => CFG)
})
afterEach(async () => {
  stopTelemetrySchedule()
  resetTelemetry()
  resetFlushState()
  await rm(dir, { recursive: true, force: true })
})

function optInAndQueue(n: number): void {
  applyConsentDecision('on') // emits session.start, like the real consent path
  for (let i = 0; i < n; i++) record('usage', 'feature.rise.opened', { i })
}

describe('transport', () => {
  // CONFIRMED 2026-08-28 against the live cutover project: a raw table
  // insert with `?on_conflict=event_id` cannot work against anon's
  // insert-only grant (Postgres's ON CONFLICT needs to visibility-check the
  // existing row, which requires SELECT). The RPC is SECURITY DEFINER so it
  // can do that check with elevated privileges while anon still never gets
  // real read access. See supabase/2026-08-telemetry.sql for the function
  // and the full incident note.
  it('targets the anon-safe RPC with the anon key only, not a direct table insert', () => {
    expect(ingestUrl(CFG)).toBe(
      'https://example-project.supabase.co/rest/v1/rpc/telemetry_ingest_batch'
    )
    expect(ingestUrl(CFG)).not.toContain('on_conflict')
    expect(ingestHeaders(CFG)).toEqual({
      apikey: 'anon-key-for-tests',
      Authorization: 'Bearer anon-key-for-tests',
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    })
  })

  it('wraps the batch as the RPC\'s named `rows` parameter, not a bare array', () => {
    const rows = toRows({
      anonId: 'a',
      sessionId: 's',
      appVersion: '1.4.0',
      platform: 'win32',
      osVersion: 'x',
      arch: 'x64',
      events: [{ id: 'e1', ts: 't1', kind: 'usage', name: 'a.b', props: {} }]
    })
    expect(ingestBody(rows)).toBe(JSON.stringify({ rows }))
  })

  it('flattens the envelope into one row per event, repeating the envelope fields', () => {
    const rows = toRows({
      anonId: 'a',
      sessionId: 's',
      appVersion: '1.4.0',
      platform: 'win32',
      osVersion: '10.0.22631',
      arch: 'x64',
      events: [
        { id: 'e1', ts: 't1', kind: 'usage', name: 'a.b', props: { n: 1 } },
        { id: 'e2', ts: 't2', kind: 'crash', name: 'crash.renderer', props: { reason: 'oom' } }
      ]
    })
    expect(rows).toEqual([
      {
        event_id: 'e1',
        anon_id: 'a',
        session_id: 's',
        app_version: '1.4.0',
        platform: 'win32',
        os_version: '10.0.22631',
        arch: 'x64',
        kind: 'usage',
        name: 'a.b',
        props: { n: 1 },
        client_ts: 't1'
      },
      {
        event_id: 'e2',
        anon_id: 'a',
        session_id: 's',
        app_version: '1.4.0',
        platform: 'win32',
        os_version: '10.0.22631',
        arch: 'x64',
        kind: 'crash',
        name: 'crash.renderer',
        props: { reason: 'oom' },
        client_ts: 't2'
      }
    ])
  })

  it('never throws: network error, timeout, non-2xx, and unconfigured all come back as ok:false', async () => {
    const env = {
      anonId: 'a',
      sessionId: 's',
      appVersion: '1.4.0',
      platform: 'win32',
      osVersion: 'x',
      arch: 'x64',
      events: [{ id: 'e', ts: 't', kind: 'usage' as const, name: 'a.b', props: {} }]
    }
    respond = () => {
      throw new TypeError('fetch failed')
    }
    expect((await sendBatch(CFG, env, { fetchImpl })).ok).toBe(false)
    respond = () => new Response('nope', { status: 401 })
    expect(await sendBatch(CFG, env, { fetchImpl })).toMatchObject({
      ok: false,
      status: 401,
      reason: 'HTTP 401'
    })
    respond = () => new Promise(() => {}) // never resolves
    const r = await sendBatch(CFG, env, { fetchImpl, timeoutMs: 20 })
    expect(r).toMatchObject({ ok: false, reason: 'AbortError' })
    expect((await sendBatch({ url: '', anonKey: '' }, env, { fetchImpl })).reason).toBe(
      'ingest not configured'
    )
  })
})

describe('flush', () => {
  it('does nothing while consent is off/unasked — fetch is never called', async () => {
    record('usage', 'feature.rise.opened') // dropped: disabled
    const r = await flushTelemetry({ fetchImpl })
    expect(r).toEqual({ attempted: false, sent: 0, remaining: 0, reason: 'consent off' })
    expect(calls).toHaveLength(0)
    setConsent(dir, 'off')
    expect((await flushTelemetry({ fetchImpl })).reason).toBe('consent off')
    expect(calls).toHaveLength(0)
  })

  it('sends, acks, and records the exact bytes in the sent log', async () => {
    optInAndQueue(3)
    const before = listQueued()
    expect(before).toHaveLength(4) // session.start + 3

    const r = await flushTelemetry({ fetchImpl, now: () => 1_700_000_000_000 })
    expect(r).toEqual({ attempted: true, sent: 4, remaining: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(ingestUrl(CFG))
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.credentials).toBe('omit')
    expect(listQueued()).toEqual([]) // acked

    const batches = listSent(dir)
    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({ sentAt: '2023-11-14T22:13:20.000Z', status: 201, count: 4 })
    expect(batches[0].body).toBe(String(calls[0].init.body)) // byte-identical to what left
    const rows = listSentRows(dir)
    expect(rows.map((x) => x.event_id).sort()).toEqual(before.map((e) => e.id).sort())
  })

  it('keeps everything queued on failure and backs off 1m → 5m → 30m → 6h', async () => {
    optInAndQueue(2)
    respond = () => new Response(null, { status: 500 })
    let t = 1_000_000
    const now = (): number => t

    expect((await flushTelemetry({ fetchImpl, now })).reason).toBe('HTTP 500')
    expect(listQueued()).toHaveLength(3)
    expect(listSent(dir)).toEqual([])
    expect((await flushTelemetry({ fetchImpl, now })).reason).toBe('backing off')
    expect(calls).toHaveLength(1) // no second request inside the window

    t += BACKOFF_MS[0] // 1 min later
    expect((await flushTelemetry({ fetchImpl, now })).reason).toBe('HTTP 500')
    t += BACKOFF_MS[0]
    expect((await flushTelemetry({ fetchImpl, now })).reason).toBe('backing off') // now needs 5 min
    t += BACKOFF_MS[1]
    expect((await flushTelemetry({ fetchImpl, now })).reason).toBe('HTTP 500')
    t += BACKOFF_MS[2]
    expect((await flushTelemetry({ fetchImpl, now })).reason).toBe('HTTP 500')
    t += BACKOFF_MS[3] - 1
    expect((await flushTelemetry({ fetchImpl, now })).reason).toBe('backing off')
    t += 1
    respond = () => new Response(null, { status: 201 })
    expect((await flushTelemetry({ fetchImpl, now })).sent).toBe(3) // recovery clears the backoff
    expect(listQueued()).toEqual([])
  })

  it('a user who opts out between the schedule firing and the send gets nothing sent', async () => {
    optInAndQueue(1)
    setConsent(dir, 'off') // wipes the queue + id
    expect((await flushTelemetry({ fetchImpl })).reason).toBe('consent off')
    expect(calls).toHaveLength(0)
  })

  it('batches at most 100 events per send and continues on the next flush', async () => {
    optInAndQueue(150)
    expect(listQueued()).toHaveLength(151)
    expect((await flushTelemetry({ fetchImpl })).sent).toBe(100)
    expect(listQueued()).toHaveLength(51)
    expect((await flushTelemetry({ fetchImpl })).sent).toBe(51)
    expect(listSent(dir).map((b) => b.count)).toEqual([100, 51])
  })

  it('the envelope carries only the install id, a session id, versions and arch', () => {
    setConsent(dir, 'on')
    const env = buildEnvelope('anon-1', '1.4.0')
    expect(Object.keys(env).sort()).toEqual([
      'anonId',
      'appVersion',
      'arch',
      'events',
      'osVersion',
      'platform',
      'sessionId'
    ])
    expect(env.anonId).toBe('anon-1')
    expect(env.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('the schedule exists and can be stopped (timers are unref-ed and cleared)', () => {
    vi.useFakeTimers()
    try {
      startTelemetrySchedule()
      expect(vi.getTimerCount()).toBe(2)
      stopTelemetrySchedule()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sent log', () => {
  it('appends, lists newest-batch-first rows, prunes, and clears', async () => {
    const mk = (i: number): string =>
      JSON.stringify([{ event_id: `e${i}`, name: 'a.b', client_ts: 't' }])
    for (let i = 1; i <= 3; i++)
      appendSent(dir, { sentAt: `t${i}`, status: 201, count: 1, body: mk(i) })
    expect(listSent(dir).map((b) => b.sentAt)).toEqual(['t1', 't2', 't3'])
    expect(listSentRows(dir).map((r) => r.event_id)).toEqual(['e3', 'e2', 'e1'])
    expect(listSentRows(dir, 2)).toHaveLength(2)
    expect(await readFile(sentLogPath(dir), 'utf8')).toContain('"body":"[{')
    clearSent(dir)
    expect(existsSync(sentLogPath(dir))).toBe(false)
    expect(listSent(dir)).toEqual([])
  })
})

describe('BUG-090 — a permanent 4xx is dropped, a 5xx is retried (the actual failure shapes)', () => {
  it('a 400-rejected batch is DROPPED, the queue keeps moving, and the very next flush sends the rest', async () => {
    optInAndQueue(2) // session.start + 2 usage events
    // The server permanently rejects the first batch (e.g. a validation
    // mismatch), then behaves normally — the real cutover-week shape.
    let first = true
    respond = () => {
      if (first) {
        first = false
        return new Response('{"message":"violates check constraint"}', { status: 400 })
      }
      return new Response(null, { status: 201 })
    }
    const drop = await flushTelemetry({ fetchImpl })
    expect(drop.reason).toBe('dropped: HTTP 400')
    expect(drop.sent).toBe(0)
    expect(listQueued()).toEqual([]) // the poisoned batch is GONE, not parked at the head
    expect(listSent(dir)).toEqual([]) // and it was never recorded as sent — the sent log doesn't lie

    record('usage', 'feature.rise.opened')
    // No backoff after a 4xx: the server answered, it is up. Same clock tick.
    const next = await flushTelemetry({ fetchImpl })
    expect(next.sent).toBe(1) // the queue moved — no head-of-line block
    expect(listSent(dir)).toHaveLength(1)
  })

  it('a 503 keeps everything queued and backs off — transient failures are still retried', async () => {
    optInAndQueue(2)
    respond = () => new Response(null, { status: 503 })
    let t = 5_000_000
    const now = (): number => t
    expect((await flushTelemetry({ fetchImpl, now })).reason).toBe('HTTP 503')
    expect(listQueued()).toHaveLength(3) // NOTHING dropped
    expect((await flushTelemetry({ fetchImpl, now })).reason).toBe('backing off')
    t += BACKOFF_MS[0]
    respond = () => new Response(null, { status: 201 })
    expect((await flushTelemetry({ fetchImpl, now })).sent).toBe(3) // recovered intact
  })

  it('a network failure (status null) is treated as transient, never as a drop', async () => {
    optInAndQueue(1)
    respond = () => {
      throw new TypeError('fetch failed')
    }
    const r = await flushTelemetry({ fetchImpl })
    expect(r.reason).not.toMatch(/^dropped/)
    expect(listQueued()).toHaveLength(2) // retained for retry
  })
})

describe('BUG-090 follow-up — 4xx classified by MEANING, not by range', () => {
  // The M29 sweep found the first version of this fix treated the whole 4xx
  // range as permanent. The day-one cutover condition is a 404 — the telemetry
  // table does not exist until the SQL is pasted — so the original fix would
  // have silently deleted the exact week the cutover most needs data.

  it('THE DAY-ONE SHAPE: 404 (table not deployed) retains everything, and it all sends once the table appears', async () => {
    optInAndQueue(2) // session.start + 2 usage events
    // Exactly what PostgREST answers for a table missing from its schema
    // cache — the state every install is in until the SQL is applied.
    respond = () =>
      new Response(
        '{"code":"PGRST205","message":"Could not find the table \'public.telemetry_events\' in the schema cache"}',
        { status: 404 }
      )
    let t = 9_000_000
    const now = (): number => t

    const first = await flushTelemetry({ fetchImpl, now })
    expect(first.reason).not.toMatch(/^dropped/) // NOT discarded
    expect(first.sent).toBe(0)
    expect(listQueued()).toHaveLength(3) // every event still here
    expect(listSent(dir)).toEqual([])

    // Days of 404s must not erode the queue.
    t += BACKOFF_MS[0]
    await flushTelemetry({ fetchImpl, now })
    t += BACKOFF_MS[1]
    await flushTelemetry({ fetchImpl, now })
    expect(listQueued()).toHaveLength(3) // still intact

    // The founder pastes the SQL. The table exists. Nothing was lost.
    t += BACKOFF_MS[2]
    respond = () => new Response(null, { status: 201 })
    expect((await flushTelemetry({ fetchImpl, now })).sent).toBe(3)
  })

  it('429 (throttled) is retained — telemetry must not degrade worst under adoption', async () => {
    optInAndQueue(1)
    respond = () => new Response(null, { status: 429 })
    expect((await flushTelemetry({ fetchImpl })).reason).not.toMatch(/^dropped/)
    expect(listQueued()).toHaveLength(2)
  })

  it('401 (anon key not deployed / rotated) is retained, not discarded', async () => {
    optInAndQueue(1)
    respond = () => new Response(null, { status: 401 })
    expect((await flushTelemetry({ fetchImpl })).reason).not.toMatch(/^dropped/)
    expect(listQueued()).toHaveLength(2)
  })

  it('408 (proxy timeout on a slow body) is retained', async () => {
    optInAndQueue(1)
    respond = () => new Response(null, { status: 408 })
    expect((await flushTelemetry({ fetchImpl })).reason).not.toMatch(/^dropped/)
    expect(listQueued()).toHaveLength(2)
  })

  it('an UNRECOGNISED 4xx retries rather than drops — unknown must fail in the safe direction', async () => {
    optInAndQueue(1)
    respond = () => new Response(null, { status: 418 })
    expect((await flushTelemetry({ fetchImpl })).reason).not.toMatch(/^dropped/)
    expect(listQueued()).toHaveLength(2)
  })

  it('400 still drops — a poisoned batch must never wedge the queue', async () => {
    optInAndQueue(1)
    respond = () => new Response(null, { status: 400 })
    expect((await flushTelemetry({ fetchImpl })).reason).toBe('dropped: HTTP 400')
    expect(listQueued()).toEqual([])
  })

  it('409 still drops', async () => {
    optInAndQueue(1)
    respond = () => new Response(null, { status: 409 })
    expect((await flushTelemetry({ fetchImpl })).reason).toBe('dropped: HTTP 409')
    expect(listQueued()).toEqual([])
  })

  it('413 still drops — the same bytes will always be too large', async () => {
    optInAndQueue(1)
    respond = () => new Response(null, { status: 413 })
    expect((await flushTelemetry({ fetchImpl })).reason).toBe('dropped: HTTP 413')
    expect(listQueued()).toEqual([])
  })

  it('422 still drops', async () => {
    optInAndQueue(1)
    respond = () => new Response(null, { status: 422 })
    expect((await flushTelemetry({ fetchImpl })).reason).toBe('dropped: HTTP 422')
    expect(listQueued()).toEqual([])
  })
})
