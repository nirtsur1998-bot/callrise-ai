// M29 A1.4 — the only code that sends telemetry bytes off the machine.
//
// DELIBERATELY NOT supabase-js. The app's shared Supabase client carries the
// signed-in user's JWT on every request (auth.ts). Using it here would let
// the server see auth.uid() next to the anonymous id — exactly the join the
// brief forbids. So this is plain fetch with the PUBLIC anon key and nothing
// else: no cookies, no session, no user token, no .updaterId.
//
// Target: the `telemetry_ingest_batch` RPC (see supabase/2026-08-telemetry.sql),
// NOT a direct table insert. CONFIRMED 2026-08-28 against the live cutover
// project: a raw `POST .../telemetry_events?on_conflict=event_id` with
// `Prefer: resolution=ignore-duplicates` cannot work against an insert-only
// grant — Postgres's ON CONFLICT needs to visibility-check the existing row,
// which an anon role with no SELECT (by design, so telemetry is truly
// write-only) can never do. The RPC is SECURITY DEFINER: it does the
// per-row `ON CONFLICT DO NOTHING` with elevated privileges, so anon still
// never gets real read access (there is no SELECT grant on the table itself),
// while every event_id in a batch is individually idempotent.
//
// Per-row, not a single bulk statement, matters here: a bulk INSERT (even
// via the old on_conflict path) is one atomic statement, so ONE
// already-delivered event_id anywhere in a batch of up to 100 would abort
// the WHOLE batch — including genuinely new events sent alongside it. That
// is a realistic case, not a hypothetical: the local queue only drops an
// event on a confirmed ack, so a batch built while some earlier send is
// stuck WILL mix already-delivered and brand-new events. The RPC's per-row
// loop is what makes a mixed batch resolve correctly instead of losing data.
//
// Pure: fetch is injected, so the privacy tests intercept the exact request.

import type { TelemetryEnvelope, TelemetryEvent } from './events'

export interface IngestConfig {
  /** The Supabase project URL, e.g. https://xxxx.supabase.co */
  url: string
  /** The PUBLIC anon key. Never a service key, never a user session token. */
  anonKey: string
}

export interface IngestRow {
  event_id: string
  anon_id: string
  session_id: string
  app_version: string
  platform: string
  os_version: string
  arch: string
  kind: string
  name: string
  props: Record<string, string | number | boolean>
  client_ts: string
}

export interface SendResult {
  ok: boolean
  status: number | null
  /** How many events the server accepted (all or none — a batch is atomic). */
  sent: number
  /** The exact bytes that were sent, for the sent log / "view what's been sent". */
  body: string
  reason?: string
}

export const MAX_BATCH = 100
export const SEND_TIMEOUT_MS = 15_000

/** Flatten an envelope into PostgREST rows. One row per event; the envelope fields repeat. */
export function toRows(envelope: TelemetryEnvelope): IngestRow[] {
  return envelope.events.map((e: TelemetryEvent) => ({
    event_id: e.id,
    anon_id: envelope.anonId,
    session_id: envelope.sessionId,
    app_version: envelope.appVersion,
    platform: envelope.platform,
    os_version: envelope.osVersion,
    arch: envelope.arch,
    kind: e.kind,
    name: e.name,
    props: e.props,
    client_ts: e.ts
  }))
}

export function ingestUrl(cfg: IngestConfig): string {
  const base = cfg.url.replace(/\/+$/, '')
  return `${base}/rest/v1/rpc/telemetry_ingest_batch`
}

/** Headers: the anon key twice (PostgREST wants both), JSON, no body back. */
export function ingestHeaders(cfg: IngestConfig): Record<string, string> {
  return {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.anonKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal'
  }
}

/** The RPC takes one named parameter, `rows`, holding the whole batch as a
 *  JSON array — not the bare array a direct table insert would take. */
export function ingestBody(rows: IngestRow[]): string {
  return JSON.stringify({ rows })
}

export interface SendDeps {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Send one batch. Never throws: network failure, timeout and non-2xx all
 * come back as { ok: false } so the caller keeps the events queued.
 */
export async function sendBatch(
  cfg: IngestConfig,
  envelope: TelemetryEnvelope,
  deps: SendDeps = {}
): Promise<SendResult> {
  const rows = toRows(envelope).slice(0, MAX_BATCH)
  const body = ingestBody(rows)
  if (rows.length === 0) return { ok: true, status: null, sent: 0, body }
  if (!cfg.url || !cfg.anonKey) {
    return { ok: false, status: null, sent: 0, body, reason: 'ingest not configured' }
  }
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SEND_TIMEOUT_MS)
  try {
    const res = await fetchImpl(ingestUrl(cfg), {
      method: 'POST',
      headers: ingestHeaders(cfg),
      body,
      signal: controller.signal,
      // Belt and braces: even if a cookie jar existed, never send one.
      credentials: 'omit'
    })
    if (res.ok) return { ok: true, status: res.status, sent: rows.length, body }
    return { ok: false, status: res.status, sent: 0, body, reason: `HTTP ${res.status}` }
  } catch (err) {
    const reason = err instanceof Error ? err.name : 'fetch failed'
    return { ok: false, status: null, sent: 0, body, reason }
  } finally {
    clearTimeout(timer)
  }
}
