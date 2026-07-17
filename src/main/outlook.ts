// Outlook / Microsoft 365 Calendar integration — the same read-only pull +
// two-way push shape as google.ts (M13/M14), aimed at Microsoft Graph instead
// of the Google Calendar API. The user authorizes in their own system browser
// (loopback + PKCE); the MSAL token cache (which holds the refresh token) is
// persisted ENCRYPTED via Electron safeStorage, in the main process only.
import { app, ipcMain, shell, safeStorage } from 'electron'
import { createServer, type Server } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  PublicClientApplication,
  type AccountInfo,
  type ICachePlugin,
  type TokenCacheContext
} from '@azure/msal-node'
import { listTombstonedKeys, type CalendarEvent } from './events-fs'
import {
  toGraphBody,
  httpStatus,
  classifyPushError,
  linkKey,
  GraphHttpError,
  type PushResult,
  type DeleteResult
} from './outlook-sync'
import { saveAppSettings } from './app-settings'

// Same split as Google: M13 read-only scope only; two-way sync widens it via a
// SEPARATE, explicit user action (never silently upgraded).
const SCOPES_RO = ['Calendars.Read', 'offline_access']
const SCOPES_RW = ['Calendars.ReadWrite', 'Calendars.Read', 'offline_access']
const AUTH_TIMEOUT_MS = 5 * 60_000
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

export type SyncMode = 'readonly' | 'readwrite'

function creds(): { clientId: string; tenant: string } | null {
  const clientId = process.env.OUTLOOK_CLIENT_ID?.trim()
  if (!clientId) return null
  const tenant = process.env.OUTLOOK_TENANT_ID?.trim() || 'common'
  return { clientId, tenant }
}

function outlookDir(): string {
  return join(app.getPath('userData'), 'outlook')
}
function msalCachePath(): string {
  return join(outlookDir(), 'msal-cache.enc')
}
function modePath(): string {
  return join(outlookDir(), 'sync-mode.json')
}

// --- Encrypted MSAL token-cache persistence ---------------------------------
// MSAL manages the refresh token internally in its own serialized cache blob
// (there's no single "refresh token string" to store, unlike Google) — a
// cachePlugin is how MSAL asks us to load/save that blob.

function makeCachePlugin(): ICachePlugin {
  return {
    beforeCacheAccess: async (ctx: TokenCacheContext) => {
      try {
        if (!safeStorage.isEncryptionAvailable()) return
        const data = safeStorage.decryptString(await fs.readFile(msalCachePath()))
        if (data) ctx.tokenCache.deserialize(data)
      } catch {
        /* no cache file yet, or decrypt failed (keychain reset) — start fresh */
      }
    },
    afterCacheAccess: async (ctx: TokenCacheContext) => {
      if (!ctx.cacheHasChanged) return
      try {
        await fs.mkdir(outlookDir(), { recursive: true })
        await fs.writeFile(msalCachePath(), safeStorage.encryptString(ctx.tokenCache.serialize()), {
          mode: 0o600
        })
      } catch {
        /* best-effort — a failed persist just means re-auth next launch */
      }
    }
  }
}

let cachedPca: PublicClientApplication | null = null
let cachedClientId: string | null = null

/** A singleton MSAL client, recreated only if the configured client id changes
 *  (e.g. a fresh .env during dev). */
function pcaClient(): PublicClientApplication | null {
  const c = creds()
  if (!c) return null
  if (cachedPca && cachedClientId === c.clientId) return cachedPca
  cachedPca = new PublicClientApplication({
    auth: { clientId: c.clientId, authority: `https://login.microsoftonline.com/${c.tenant}` },
    cache: { cachePlugin: makeCachePlugin() }
  })
  cachedClientId = c.clientId
  return cachedPca
}

async function currentAccount(pca: PublicClientApplication): Promise<AccountInfo | null> {
  const accounts = await pca.getTokenCache().getAllAccounts()
  return accounts[0] ?? null
}

async function clearCache(pca: PublicClientApplication | null): Promise<void> {
  if (pca) {
    const account = await currentAccount(pca).catch(() => null)
    if (account)
      await pca
        .getTokenCache()
        .removeAccount(account)
        .catch(() => {})
  }
  await fs.unlink(msalCachePath()).catch(() => {})
}

// --- Sync mode (read-only vs two-way) --------------------------------------

async function saveMode(mode: SyncMode): Promise<void> {
  await fs.mkdir(outlookDir(), { recursive: true })
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

/** True only when the user enabled two-way sync AND an account is connected.
 *  Every write path gates on this — no write can happen in read-only mode. */
export async function isOutlookSyncEnabled(): Promise<boolean> {
  if ((await loadMode()) !== 'readwrite') return false
  const pca = pcaClient()
  if (!pca) return false
  return (await currentAccount(pca)) !== null
}

function scopesForMode(mode: SyncMode): string[] {
  return mode === 'readwrite' ? SCOPES_RW : SCOPES_RO
}

/** A fresh access token for the connected account (MSAL renews it from the
 *  cached refresh token as needed), or null when not connected. */
async function accessToken(): Promise<string | null> {
  const pca = pcaClient()
  if (!pca) return null
  const account = await currentAccount(pca)
  if (!account) return null
  try {
    const mode = await loadMode()
    const result = await pca.acquireTokenSilent({ account, scopes: scopesForMode(mode) })
    return result?.accessToken ?? null
  } catch {
    // Refresh failed (revoked / expired beyond renewal) — treat as disconnected.
    return null
  }
}

// --- OAuth connect (system browser + loopback + PKCE) ----------------------

export type ConnectResult = { ok: true } | { ok: false; error: string }

let activeServer: Server | null = null

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

function connect(scopes: string[], mode: SyncMode): Promise<ConnectResult> {
  return new Promise<ConnectResult>((resolve) => {
    const pca = pcaClient()
    if (!pca) return resolve({ ok: false, error: 'no-credentials' })
    if (!safeStorage.isEncryptionAvailable())
      return resolve({ ok: false, error: 'encryption-unavailable' })

    try {
      activeServer?.close()
    } catch {
      /* ignore */
    }
    activeServer = null

    const state = randomBytes(16).toString('hex')
    const { verifier, challenge } = generatePkce()
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
      if (req.method !== 'GET' || url.searchParams.get('state') !== state) {
        res.writeHead(404)
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0d11;color:#e7e9ec;display:grid;place-items:center;height:100vh;margin:0"><p>You can close this tab and return to CallRise AI.</p></body>'
      )
      const err = url.searchParams.get('error')
      if (err) return finish({ ok: false, error: err })
      const code = url.searchParams.get('code')
      if (!code) return finish({ ok: false, error: 'no-code' })
      const redirectUri = `http://127.0.0.1:${port}`
      void pca
        .acquireTokenByCode({ code, codeVerifier: verifier, redirectUri, scopes })
        .then(async (result) => {
          if (!result?.account) return finish({ ok: false, error: 'no-account' })
          await saveMode(mode)
          saveAppSettings({ outlookCalendarConnected: true })
          finish({ ok: true })
        })
        .catch(() => finish({ ok: false, error: 'token-exchange-failed' }))
    })

    server.on('error', () => finish({ ok: false, error: 'server-error' }))

    let port = 0
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      port = addr && typeof addr === 'object' ? addr.port : 0
      if (!port) return finish({ ok: false, error: 'no-port' })
      const redirectUri = `http://127.0.0.1:${port}`
      pca
        .getAuthCodeUrl({
          scopes,
          redirectUri,
          codeChallenge: challenge,
          codeChallengeMethod: 'S256',
          state,
          prompt: 'select_account'
        })
        .then((authUrl) => shell.openExternal(authUrl))
        .catch(() => finish({ ok: false, error: 'auth-launch-failed' }))
    })

    activeServer = server
    timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), AUTH_TIMEOUT_MS)
  })
}

// --- Status / disconnect ----------------------------------------------------

async function getStatus(): Promise<{ connected: boolean; configured: boolean; mode: SyncMode }> {
  const configured = creds() !== null && safeStorage.isEncryptionAvailable()
  const pca = configured ? pcaClient() : null
  const connected = pca ? (await currentAccount(pca)) !== null : false
  const mode = connected ? await loadMode() : 'readonly'
  return { connected, configured, mode }
}

async function disconnect(): Promise<{ ok: boolean }> {
  await clearCache(pcaClient())
  await clearMode()
  await clearOutlookCache()
  cachedPrimaryId = null
  saveAppSettings({ outlookCalendarConnected: false })
  return { ok: true }
}

export type OutlookCalendarSummary = { id: string; summary: string; primary: boolean }
export type ListCalendarsResult =
  { ok: true; calendars: OutlookCalendarSummary[] } | { ok: false; error: string }

async function graphFetch<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  })
  if (!res.ok) throw new GraphHttpError(res.status, res.statusText)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

interface RawCalendar {
  id?: string
  name?: string
  canEdit?: boolean
  isDefaultCalendar?: boolean
}

async function listCalendars(): Promise<ListCalendarsResult> {
  const token = await accessToken()
  if (!token) return { ok: false, error: 'not-connected' }
  try {
    const res = await graphFetch<{ value?: RawCalendar[] }>(
      token,
      `${GRAPH_BASE}/me/calendars?$top=50`
    )
    const calendars = (res.value ?? []).map((c) => ({
      id: c.id ?? '',
      summary: c.name ?? '(no name)',
      primary: c.isDefaultCalendar === true
    }))
    return { ok: true, calendars }
  } catch {
    return { ok: false, error: 'read-failed' }
  }
}

// --- Pull events (read-only) into a local cache ----------------------------

export interface OutlookEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  source: 'outlook'
  provider: string // `outlook:<calendarId>`
  externalId: string
  writable: boolean
  htmlLink?: string
  attendees?: { email: string; name?: string }[]
  createdAt: string
  updatedAt: string
}
export type PullEventsResult = { ok: true; events: OutlookEvent[] } | { ok: false; error: string }

const PULL_BACK_DAYS = 30
const PULL_FWD_DAYS = 90
const MAX_PAGES = 10
const DAY_MS = 86_400_000

function cachePath(): string {
  return join(outlookDir(), 'events.json')
}

async function writeCache(events: OutlookEvent[]): Promise<void> {
  await fs.mkdir(outlookDir(), { recursive: true })
  await fs.writeFile(cachePath(), JSON.stringify(events), 'utf8')
}

let cacheOp: Promise<unknown> = Promise.resolve()
function withCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = cacheOp.then(fn, fn)
  cacheOp = result.then(
    () => {},
    () => {}
  )
  return result
}

async function readCache(): Promise<OutlookEvent[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath(), 'utf8'))
    return Array.isArray(parsed) ? (parsed as OutlookEvent[]) : []
  } catch {
    return []
  }
}

async function clearOutlookCache(): Promise<void> {
  await fs.unlink(cachePath()).catch(() => {})
}

function stableId(provider: string, externalId: string): string {
  return 'o-' + createHash('sha1').update(`${provider}|${externalId}`).digest('hex')
}

function parseLocalDate(d: string): Date {
  const [y, m, day] = d.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, day ?? 1)
}

interface RawAttendee {
  emailAddress?: { address?: string; name?: string }
  type?: string // 'required' | 'optional' | 'resource'
}

interface RawEvent {
  id?: string
  isCancelled?: boolean
  subject?: string
  webLink?: string
  createdDateTime?: string
  lastModifiedDateTime?: string
  isAllDay?: boolean
  start?: { dateTime?: string }
  end?: { dateTime?: string }
  attendees?: RawAttendee[]
}

const MAX_ATTENDEES = 10

/** The other people on the invite. Graph doesn't flag "self" the way Google
 *  does, so unlike google.ts this can't exclude the connected account itself —
 *  a low-stakes gap (worst case, one extra name in a calendar-match suggestion). */
function mapAttendees(
  raw: RawAttendee[] | undefined
): { email: string; name?: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const people = raw
    .filter((a) => a.emailAddress?.address && a.type !== 'resource')
    .slice(0, MAX_ATTENDEES)
    .map((a) => ({
      email: (a.emailAddress!.address as string).toLowerCase(),
      name: a.emailAddress?.name?.trim() || undefined
    }))
  return people.length ? people : undefined
}

/** Map a Graph event to an OutlookEvent, or null to drop it (cancelled/invalid).
 *  We always request Graph with `Prefer: outlook.timezone="UTC"`, so
 *  start/end.dateTime are naive UTC strings — appending 'Z' gives the correct
 *  instant. created/lastModified are unaffected by that header and already
 *  carry their own offset. */
function mapEvent(raw: RawEvent, calendarId: string, writable: boolean): OutlookEvent | null {
  if (!raw.id || raw.isCancelled === true) return null
  const provider = `outlook:${calendarId}`
  const allDay = raw.isAllDay === true
  let start: string
  let end: string
  if (allDay) {
    const startDateStr = raw.start?.dateTime?.split('T')[0]
    if (!startDateStr) return null
    const s = parseLocalDate(startDateStr)
    const endDateStr = raw.end?.dateTime?.split('T')[0]
    // Graph's all-day end.dateTime is EXCLUSIVE (the day after), same as Google.
    const exclusiveEnd = endDateStr ? parseLocalDate(endDateStr) : new Date(s.getTime() + DAY_MS)
    start = s.toISOString()
    end = new Date(exclusiveEnd.getTime() - 1).toISOString()
  } else {
    const sdt = raw.start?.dateTime
    if (!sdt) return null
    start = new Date(`${sdt}Z`).toISOString()
    end = new Date(`${raw.end?.dateTime ?? sdt}Z`).toISOString()
  }
  const now = new Date().toISOString()
  return {
    id: stableId(provider, raw.id),
    title: raw.subject?.trim() || '(no title)',
    start,
    end,
    allDay,
    source: 'outlook',
    provider,
    externalId: raw.id,
    writable,
    htmlLink: raw.webLink,
    attendees: mapAttendees(raw.attendees),
    createdAt: raw.createdDateTime ?? now,
    updatedAt: raw.lastModifiedDateTime ?? now
  }
}

async function fetchCalendars(token: string): Promise<Array<{ id: string; writable: boolean }>> {
  const res = await graphFetch<{ value?: RawCalendar[] }>(
    token,
    `${GRAPH_BASE}/me/calendars?$top=50`
  )
  return (res.value ?? [])
    .filter((c): c is { id: string; canEdit?: boolean } => Boolean(c.id))
    .map((c) => ({ id: c.id, writable: c.canEdit === true }))
}

async function pullEvents(): Promise<PullEventsResult> {
  const token = await accessToken()
  if (!token) return { ok: false, error: 'not-connected' }
  const now = Date.now()
  const startDateTime = new Date(now - PULL_BACK_DAYS * DAY_MS).toISOString()
  const endDateTime = new Date(now + PULL_FWD_DAYS * DAY_MS).toISOString()
  const all: OutlookEvent[] = []
  try {
    const calendars = await fetchCalendars(token)
    for (const cal of calendars) {
      let url =
        `${GRAPH_BASE}/me/calendars/${encodeURIComponent(cal.id)}/calendarView` +
        `?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}&$top=250`
      let pages = 0
      while (url && pages < MAX_PAGES) {
        const res: { value?: RawEvent[]; '@odata.nextLink'?: string } = await graphFetch(
          token,
          url,
          { headers: { Prefer: 'outlook.timezone="UTC"' } }
        )
        for (const raw of res.value ?? []) {
          const ev = mapEvent(raw, cal.id, cal.writable)
          if (ev) all.push(ev)
        }
        url = res['@odata.nextLink'] ?? ''
        pages += 1
      }
    }
  } catch {
    return { ok: false, error: 'read-failed' }
  }
  const events = await withoutTombstoned(all)
  await withCacheLock(() => writeCache(events))
  return { ok: true, events }
}

function eventsDirPath(): string {
  return join(app.getPath('userData'), 'events')
}

async function withoutTombstoned(events: OutlookEvent[]): Promise<OutlookEvent[]> {
  const gone = await listTombstonedKeys(eventsDirPath())
  return gone.size ? events.filter((e) => !gone.has(linkKey(e.provider, e.externalId))) : events
}

// --- Push local events OUT to Outlook (two-way sync) -----------------------

function eventsUrl(calId: string): string {
  return calId === 'primary'
    ? `${GRAPH_BASE}/me/events`
    : `${GRAPH_BASE}/me/calendars/${encodeURIComponent(calId)}/events`
}

function calendarIdFromProvider(provider?: string): string {
  return provider?.startsWith('outlook:') ? provider.slice('outlook:'.length) : 'primary'
}

let cachedPrimaryId: string | null = null

async function primaryCalendarId(token: string): Promise<string | null> {
  if (cachedPrimaryId) return cachedPrimaryId
  try {
    const res = await graphFetch<{ value?: RawCalendar[] }>(
      token,
      `${GRAPH_BASE}/me/calendars?$top=50`
    )
    cachedPrimaryId = (res.value ?? []).find((c) => c.isDefaultCalendar === true)?.id ?? null
    return cachedPrimaryId
  } catch {
    return null
  }
}

/**
 * Create the event in Outlook. Unlike Google, Graph does NOT accept a
 * client-supplied event id, so a crash between this POST succeeding and the
 * result being recorded locally can (rarely) create a duplicate on retry —
 * an accepted, documented tradeoff rather than the extra Graph round-trip a
 * true idempotency check (matching on a custom extended property) would add.
 */
export async function pushInsertEvent(ev: CalendarEvent, calId = 'primary'): Promise<PushResult> {
  if (!(await isOutlookSyncEnabled())) return { ok: false, error: 'not-enabled', retryable: false }
  const token = await accessToken()
  if (!token) return { ok: false, error: 'not-connected', retryable: false }
  const concreteId = calId === 'primary' ? await primaryCalendarId(token) : calId
  if (!concreteId) return { ok: false, error: 'offline', retryable: true }
  const provider = `outlook:${concreteId}`
  try {
    const res = await graphFetch<{ id?: string; lastModifiedDateTime?: string }>(
      token,
      eventsUrl(calId),
      { method: 'POST', body: JSON.stringify(toGraphBody(ev)) }
    )
    if (!res.id) return { ok: false, error: 'no-id', retryable: true }
    return { ok: true, externalId: res.id, provider, remoteUpdatedAt: res.lastModifiedDateTime }
  } catch (e) {
    return classifyPushError(e)
  }
}

/** Update the linked Outlook event with PATCH. An event that was never linked
 *  is created instead (adoption); one Outlook no longer has (404) is re-created. */
export async function pushUpdateEvent(ev: CalendarEvent): Promise<PushResult> {
  if (!(await isOutlookSyncEnabled())) return { ok: false, error: 'not-enabled', retryable: false }
  if (!ev.externalId) return pushInsertEvent(ev)
  const token = await accessToken()
  if (!token) return { ok: false, error: 'not-connected', retryable: false }
  const calId = calendarIdFromProvider(ev.provider)
  try {
    const res = await graphFetch<{ lastModifiedDateTime?: string }>(
      token,
      `${eventsUrl(calId)}/${encodeURIComponent(ev.externalId)}`,
      { method: 'PATCH', body: JSON.stringify(toGraphBody(ev)) }
    )
    const provider = ev.provider ?? `outlook:${(await primaryCalendarId(token)) ?? 'primary'}`
    return {
      ok: true,
      externalId: ev.externalId,
      provider,
      remoteUpdatedAt: res.lastModifiedDateTime
    }
  } catch (e) {
    if (httpStatus(e) === 404 || httpStatus(e) === 410) return pushInsertEvent(ev, calId)
    return classifyPushError(e)
  }
}

/** Delete the linked Outlook event. Already-gone (404/410) counts as success. */
export async function pushDeleteEvent(
  externalId: string,
  provider?: string
): Promise<DeleteResult> {
  if (!(await isOutlookSyncEnabled())) return { ok: false, error: 'not-enabled', retryable: false }
  const token = await accessToken()
  if (!token) return { ok: false, error: 'not-connected', retryable: false }
  const calId = calendarIdFromProvider(provider)
  try {
    await graphFetch(token, `${eventsUrl(calId)}/${encodeURIComponent(externalId)}`, {
      method: 'DELETE'
    })
    return { ok: true }
  } catch (e) {
    if (httpStatus(e) === 404 || httpStatus(e) === 410) return { ok: true }
    return classifyPushError(e)
  }
}

export async function dropCachedEvent(externalId: string, provider?: string): Promise<void> {
  const key = provider ? linkKey(provider, externalId) : null
  await withCacheLock(async () => {
    const events = await readCache()
    const filtered = key
      ? events.filter((e) => linkKey(e.provider, e.externalId) !== key)
      : events.filter((e) => e.externalId !== externalId)
    if (filtered.length !== events.length) await writeCache(filtered)
  })
}

let registered = false

export function registerOutlook(): void {
  if (registered) return
  registered = true
  ipcMain.handle('outlook:getStatus', () => getStatus())
  ipcMain.handle('outlook:connect', () => connect(SCOPES_RO, 'readonly'))
  ipcMain.handle('outlook:connectWrite', () => connect(SCOPES_RW, 'readwrite'))
  ipcMain.handle('outlook:disconnect', () => disconnect())
  ipcMain.handle('outlook:listCalendars', () => listCalendars())
  ipcMain.handle('outlook:pullEvents', () => pullEvents())
  ipcMain.handle('outlook:cachedEvents', () => readCache().then(withoutTombstoned))
}
