// Google Calendar integration (M13, read-only). The user authorizes in their
// own system browser; we never see their password. The OAuth handshake uses the
// loopback + PKCE flow (Google's recommended method for Desktop apps), and the
// refresh token is stored ENCRYPTED via Electron safeStorage (macOS Keychain),
// in the main process only.
//
// READ-ONLY: the requested scope grants read access to calendars + events and
// nothing else — M13 never creates/edits/deletes anything in Google Calendar.
// (M14 will widen the scope for two-way sync.)
import { app, ipcMain, shell, safeStorage } from 'electron'
import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'
import type { CalendarEvent } from './events-fs'
import {
  toGoogleBody,
  toGoogleEventId,
  httpStatus,
  classifyPushError,
  type PushResult
} from './google-sync'

// M13 read-only scope. M14 adds a SEPARATE write flow (calendar.events) so the
// read-only path is never silently widened — the user explicitly opts into it.
const SCOPES_RO = ['https://www.googleapis.com/auth/calendar.readonly']
// Two-way sync: calendar.events grants event create/edit/delete (NOT calendar
// management). We keep readonly too so the pull's calendarList enumeration works.
const SCOPES_RW = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly'
]
const AUTH_TIMEOUT_MS = 5 * 60_000 // give up if the user never finishes authorizing

/** Whether the app may write to Google: 'readonly' (M13) or 'readwrite' (M14). */
export type SyncMode = 'readonly' | 'readwrite'

interface Creds {
  clientId: string
  clientSecret: string
}

function creds(): Creds | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

function googleDir(): string {
  return join(app.getPath('userData'), 'google')
}
function tokenPath(): string {
  return join(googleDir(), 'token.enc')
}

// --- Encrypted refresh-token storage ---------------------------------------

async function saveRefreshToken(token: string): Promise<void> {
  await fs.mkdir(googleDir(), { recursive: true })
  // 0600: owner-only, defense-in-depth on top of the encryption.
  await fs.writeFile(tokenPath(), safeStorage.encryptString(token), { mode: 0o600 })
}

async function loadRefreshToken(): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const token = safeStorage.decryptString(await fs.readFile(tokenPath()))
    return token || null
  } catch {
    // Missing file, or decrypt failed (keychain reset / moved machine) → treat
    // as disconnected; the user just re-authorizes.
    return null
  }
}

async function clearRefreshToken(): Promise<void> {
  await fs.unlink(tokenPath()).catch(() => {})
}

// --- Sync mode (read-only vs two-way) --------------------------------------

function modePath(): string {
  return join(googleDir(), 'sync-mode.json')
}

// The mode is not a secret — it grants nothing on its own (only the token does),
// so it's plain JSON. A missing file means 'readonly' (M13 tokens predate it).
async function saveMode(mode: SyncMode): Promise<void> {
  await fs.mkdir(googleDir(), { recursive: true })
  await fs.writeFile(modePath(), JSON.stringify({ mode }), 'utf8')
}

async function loadMode(): Promise<SyncMode> {
  try {
    const parsed = JSON.parse(await fs.readFile(modePath(), 'utf8'))
    return parsed?.mode === 'readwrite' ? 'readwrite' : 'readonly'
  } catch {
    return 'readonly'
  }
}

async function clearMode(): Promise<void> {
  await fs.unlink(modePath()).catch(() => {})
}

/** True only when the user enabled two-way sync AND a token is stored. Every
 *  write path (M14) gates on this — no write can happen in read-only mode. */
export async function isGoogleSyncEnabled(): Promise<boolean> {
  if ((await loadMode()) !== 'readwrite') return false
  return (await loadRefreshToken()) !== null
}

/** An OAuth client primed with the stored refresh token (auto-refreshes access
 *  tokens), or null when not connected. */
async function authedClient(): Promise<OAuth2Client | null> {
  const c = creds()
  const refreshToken = await loadRefreshToken()
  if (!c || !refreshToken) return null
  const client = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret })
  client.setCredentials({ refresh_token: refreshToken })
  return client
}

// --- OAuth connect (system browser + loopback + PKCE) ----------------------

export type ConnectResult = { ok: true } | { ok: false; error: string }

let activeServer: Server | null = null

function connect(scopes: string[], mode: SyncMode): Promise<ConnectResult> {
  return new Promise<ConnectResult>((resolve) => {
    const c = creds()
    if (!c) return resolve({ ok: false, error: 'no-credentials' })
    if (!safeStorage.isEncryptionAvailable())
      return resolve({ ok: false, error: 'encryption-unavailable' })

    // Never leave a prior in-flight attempt running.
    try {
      activeServer?.close()
    } catch {
      /* ignore */
    }
    activeServer = null

    const state = randomBytes(16).toString('hex') // CSRF guard for the callback
    let client: OAuth2Client | null = null
    let codeVerifier = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: ConnectResult): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        server.close()
      } catch {
        /* ignore */
      }
      if (activeServer === server) activeServer = null
      resolve(result)
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // Only a GET carrying OUR state is the real OAuth callback. Anything else
      // (favicons, port scans, spurious/forged hits from other local processes)
      // is ignored — so it can't pre-empt or spoof the real redirect.
      if (req.method !== 'GET' || url.searchParams.get('state') !== state) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0d11;color:#e7e9ec;display:grid;place-items:center;height:100vh;margin:0"><p>You can close this tab and return to Sales OS.</p></body>'
      )
      const err = url.searchParams.get('error')
      if (err) return finish({ ok: false, error: err })
      const code = url.searchParams.get('code')
      if (!code || !client) return finish({ ok: false, error: 'no-code' })
      void client
        .getToken({ code, codeVerifier })
        .then(async ({ tokens }) => {
          if (!tokens.refresh_token) return finish({ ok: false, error: 'no-refresh-token' })
          await saveRefreshToken(tokens.refresh_token)
          await saveMode(mode)
          finish({ ok: true })
        })
        .catch(() => finish({ ok: false, error: 'token-exchange-failed' }))
    })

    server.on('error', () => finish({ ok: false, error: 'server-error' }))

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      if (!port) return finish({ ok: false, error: 'no-port' })
      const oauth = new OAuth2Client({
        clientId: c.clientId,
        clientSecret: c.clientSecret,
        redirectUri: `http://127.0.0.1:${port}`
      })
      client = oauth
      oauth
        .generateCodeVerifierAsync()
        .then((pkce) => {
          codeVerifier = pkce.codeVerifier
          const authUrl = oauth.generateAuthUrl({
            access_type: 'offline', // ask for a refresh token
            prompt: 'consent', // ensure a refresh token is returned
            include_granted_scopes: true, // incremental: new grant also covers prior scopes
            scope: scopes,
            code_challenge_method: CodeChallengeMethod.S256,
            code_challenge: pkce.codeChallenge,
            state
          })
          return shell.openExternal(authUrl)
        })
        // Fail fast if PKCE or the browser launch throws (don't stall for 5 min).
        .catch(() => finish({ ok: false, error: 'auth-launch-failed' }))
    })

    activeServer = server
    timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), AUTH_TIMEOUT_MS)
  })
}

// --- Status / disconnect / the proof read ----------------------------------

async function getStatus(): Promise<{ connected: boolean; configured: boolean; mode: SyncMode }> {
  const configured = creds() !== null && safeStorage.isEncryptionAvailable()
  const connected = configured ? (await loadRefreshToken()) !== null : false
  const mode = connected ? await loadMode() : 'readonly'
  return { connected, configured, mode }
}

async function disconnect(): Promise<{ ok: boolean }> {
  const token = await loadRefreshToken()
  const c = creds()
  if (token && c) {
    // Best-effort: also revoke at Google so the grant is gone, not just local.
    const client = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret })
    await client.revokeToken(token).catch(() => {})
  }
  await clearRefreshToken()
  await clearMode() // back to read-only on the next connect
  await clearCache() // pulled events are meaningless once disconnected
  cachedPrimaryId = null
  return { ok: true }
}

export type GoogleCalendarSummary = { id: string; summary: string; primary: boolean }
export type ListCalendarsResult =
  { ok: true; calendars: GoogleCalendarSummary[] } | { ok: false; error: string }

/** The Step-1 proof: one authenticated read that lists the user's calendars. */
async function listCalendars(): Promise<ListCalendarsResult> {
  const client = await authedClient()
  if (!client) return { ok: false, error: 'not-connected' }
  try {
    // Authenticated read via the OAuth client (auto-refreshes the access token).
    const res = await client.request<{
      items?: Array<{ id?: string; summary?: string; primary?: boolean }>
    }>({
      url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      params: { maxResults: 50 }
    })
    const calendars = (res.data.items ?? []).map((item) => ({
      id: item.id ?? '',
      summary: item.summary ?? '(no name)',
      primary: item.primary === true
    }))
    return { ok: true, calendars }
  } catch {
    return { ok: false, error: 'read-failed' }
  }
}

// --- Pull events (read-only) into a local cache ----------------------------

// A pulled Google event, shaped like the app's CalendarEvent so the calendar UI
// can render it directly. source/provider/externalId keep it distinct from
// local events (the match key M14's two-way sync will use).
export interface GoogleEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  source: 'google'
  provider: string // `google:<calendarId>`
  externalId: string // the Google event id
  htmlLink?: string
  createdAt: string
  updatedAt: string
}
export type PullEventsResult = { ok: true; events: GoogleEvent[] } | { ok: false; error: string }

const PULL_BACK_DAYS = 30
const PULL_FWD_DAYS = 90
const MAX_PAGES = 10 // safety cap per calendar
const DAY_MS = 86_400_000

function cachePath(): string {
  return join(googleDir(), 'events.json')
}

async function writeCache(events: GoogleEvent[]): Promise<void> {
  await fs.mkdir(googleDir(), { recursive: true })
  await fs.writeFile(cachePath(), JSON.stringify(events), 'utf8')
}

async function readCache(): Promise<GoogleEvent[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath(), 'utf8'))
    return Array.isArray(parsed) ? (parsed as GoogleEvent[]) : []
  } catch {
    return []
  }
}

async function clearCache(): Promise<void> {
  await fs.unlink(cachePath()).catch(() => {})
}

/** Deterministic app id from the Google identity, so re-pulls overwrite (never
 *  duplicate) and M14 can match by it. */
function stableId(provider: string, externalId: string): string {
  return 'g-' + createHash('sha1').update(`${provider}|${externalId}`).digest('hex')
}

function parseLocalDate(d: string): Date {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, day ?? 1)
}

interface RawEvent {
  id?: string
  status?: string
  summary?: string
  htmlLink?: string
  created?: string
  updated?: string
  start?: { date?: string; dateTime?: string }
  end?: { date?: string; dateTime?: string }
}

/** Map a Google API event to a GoogleEvent, or null to drop it (cancelled/invalid). */
function mapEvent(raw: RawEvent, calendarId: string): GoogleEvent | null {
  if (!raw.id || raw.status === 'cancelled') return null
  const provider = `google:${calendarId}`
  const allDay = Boolean(raw.start?.date && !raw.start?.dateTime)
  let start: string
  let end: string
  if (allDay) {
    const s = parseLocalDate(raw.start!.date as string)
    // Google's all-day end.date is EXCLUSIVE (the day after) — make it inclusive.
    const exclusiveEnd = raw.end?.date
      ? parseLocalDate(raw.end.date)
      : new Date(s.getTime() + DAY_MS)
    start = s.toISOString()
    end = new Date(exclusiveEnd.getTime() - 1).toISOString()
  } else {
    const sdt = raw.start?.dateTime
    if (!sdt) return null
    start = new Date(sdt).toISOString()
    end = new Date(raw.end?.dateTime ?? sdt).toISOString()
  }
  const now = new Date().toISOString()
  return {
    id: stableId(provider, raw.id),
    title: raw.summary?.trim() || '(no title)',
    start,
    end,
    allDay,
    source: 'google',
    provider,
    externalId: raw.id,
    htmlLink: raw.htmlLink,
    createdAt: raw.created ?? now,
    updatedAt: raw.updated ?? now
  }
}

async function fetchCalendarIds(client: OAuth2Client): Promise<string[]> {
  const res = await client.request<{ items?: Array<{ id?: string }> }>({
    url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    params: { maxResults: 50 }
  })
  return (res.data.items ?? []).map((i) => i.id).filter((id): id is string => Boolean(id))
}

/** Pull recent + upcoming events from every calendar into the read-only cache. */
async function pullEvents(): Promise<PullEventsResult> {
  const client = await authedClient()
  if (!client) return { ok: false, error: 'not-connected' }
  const now = Date.now()
  const timeMin = new Date(now - PULL_BACK_DAYS * DAY_MS).toISOString()
  const timeMax = new Date(now + PULL_FWD_DAYS * DAY_MS).toISOString()
  const all: GoogleEvent[] = []
  try {
    const calendarIds = await fetchCalendarIds(client)
    for (const calId of calendarIds) {
      let pageToken: string | undefined
      let pages = 0
      do {
        const res = await client.request<{ items?: RawEvent[]; nextPageToken?: string }>({
          url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`,
          params: {
            timeMin,
            timeMax,
            singleEvents: true, // expand recurring events into instances
            orderBy: 'startTime',
            maxResults: 250,
            ...(pageToken ? { pageToken } : {})
          }
        })
        for (const raw of res.data.items ?? []) {
          const ev = mapEvent(raw, calId)
          if (ev) all.push(ev)
        }
        pageToken = res.data.nextPageToken ?? undefined
        pages += 1
      } while (pageToken && pages < MAX_PAGES)
    }
  } catch {
    return { ok: false, error: 'read-failed' }
  }
  await writeCache(all)
  return { ok: true, events: all }
}

// --- Push local events OUT to Google (M14 two-way sync) --------------------

const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

// The concrete primary calendar id (e.g. "you@gmail.com"), cached per session.
// We stamp THIS on pushed events — never the "primary" alias — so their
// (provider, externalId) match key equals what the pull produces, and the
// dedup drops the echoed copy instead of showing it twice.
let cachedPrimaryId: string | null = null

async function primaryCalendarId(client: OAuth2Client): Promise<string | null> {
  if (cachedPrimaryId) return cachedPrimaryId
  try {
    const res = await client.request<{ items?: Array<{ id?: string; primary?: boolean }> }>({
      url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      params: { maxResults: 50 }
    })
    cachedPrimaryId = (res.data.items ?? []).find((i) => i.primary === true)?.id ?? null
    return cachedPrimaryId
  } catch {
    return null
  }
}

async function fetchEventUpdated(client: OAuth2Client, id: string): Promise<string | undefined> {
  try {
    const res = await client.request<{ updated?: string }>({
      url: `${EVENTS_URL}/${encodeURIComponent(id)}`
    })
    return res.data.updated
  } catch {
    return undefined
  }
}

/** Create the event in Google's primary calendar. Idempotent: uses a
 *  deterministic id so a crash-retry can't double-create. */
export async function pushInsertEvent(ev: CalendarEvent): Promise<PushResult> {
  if (!(await isGoogleSyncEnabled())) return { ok: false, error: 'not-enabled', retryable: false }
  const client = await authedClient()
  if (!client) return { ok: false, error: 'not-connected', retryable: false }
  const primaryId = await primaryCalendarId(client)
  if (!primaryId) return { ok: false, error: 'offline', retryable: true }
  const provider = `google:${primaryId}`
  const externalId = toGoogleEventId(ev.id)
  try {
    const res = await client.request<{ updated?: string }>({
      method: 'POST',
      url: EVENTS_URL,
      data: { id: externalId, ...toGoogleBody(ev) }
    })
    return { ok: true, externalId, provider, googleUpdatedAt: res.data.updated }
  } catch (e) {
    // 409 = this id already exists (a prior attempt succeeded before we recorded
    // the link). That's success — adopt the existing event, don't re-create.
    if (httpStatus(e) === 409) {
      const googleUpdatedAt = await fetchEventUpdated(client, externalId)
      return { ok: true, externalId, provider, googleUpdatedAt }
    }
    return classifyPushError(e)
  }
}

let registered = false

export function registerGoogle(): void {
  if (registered) return
  registered = true
  ipcMain.handle('google:getStatus', () => getStatus())
  ipcMain.handle('google:connect', () => connect(SCOPES_RO, 'readonly'))
  ipcMain.handle('google:connectWrite', () => connect(SCOPES_RW, 'readwrite'))
  ipcMain.handle('google:disconnect', () => disconnect())
  ipcMain.handle('google:listCalendars', () => listCalendars())
  ipcMain.handle('google:pullEvents', () => pullEvents())
  ipcMain.handle('google:cachedEvents', () => readCache())
}
