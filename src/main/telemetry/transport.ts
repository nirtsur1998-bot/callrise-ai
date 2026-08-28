// M29 A1.4 — the only code that sends telemetry bytes off the machine.
//
// DELIBERATELY NOT supabase-js. The app's shared Supabase client carries the
// signed-in user's JWT on every request (auth.ts). Using it here would let
// the server see auth.uid() next to the anonymous id — exactly the join the
// brief forbids. So this is plain fetch with the PUBLIC anon key and nothing
// else: no cookies, no session, no user token, no .updaterId.
//
// Target: PostgREST insert into public.telemetry_events (see
// supabase/2026-08-telemetry.sql — anon may INSERT and nothing else). A
// retried batch is idempotent via `on_conflict=event_id` +
// `resolution=ignore-duplicates`.
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
  return `${base}/rest/v1/telemetry_events?on_conflict=event_id`
}

/** Headers: the anon key twice (PostgREST wants both), JSON, idempotent insert, no body back. */
export function ingestHeaders(cfg: IngestConfig): Record<string, string> {
  return {
    apikey: cfg.anonKey,
    Authorization: `Bearer ${cfg.anonKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal,resolution=ignore-duplicates'
  }
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
  const body = JSON.stringify(rows)
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
