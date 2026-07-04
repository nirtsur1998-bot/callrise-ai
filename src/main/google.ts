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
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly']
const AUTH_TIMEOUT_MS = 5 * 60_000 // give up if the user never finishes authorizing

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

function connect(): Promise<ConnectResult> {
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
            scope: SCOPES,
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

async function getStatus(): Promise<{ connected: boolean; configured: boolean }> {
  const configured = creds() !== null && safeStorage.isEncryptionAvailable()
  const connected = configured ? (await loadRefreshToken()) !== null : false
  return { connected, configured }
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

let registered = false

export function registerGoogle(): void {
  if (registered) return
  registered = true
  ipcMain.handle('google:getStatus', () => getStatus())
  ipcMain.handle('google:connect', () => connect())
  ipcMain.handle('google:disconnect', () => disconnect())
  ipcMain.handle('google:listCalendars', () => listCalendars())
}
