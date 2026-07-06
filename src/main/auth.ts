import { app, ipcMain, BrowserWindow, safeStorage } from 'electron'
import { join } from 'node:path'
import { chmodSync, readFileSync, writeFile } from 'node:fs'
import {
  createClient,
  AuthError,
  type SupabaseClient,
  type User,
  type SupportedStorage
} from '@supabase/supabase-js'

// What the renderer is allowed to see about the signed-in user. Tokens never
// leave the main process — only this safe shape crosses the IPC bridge.
export interface AuthUser {
  id: string
  email: string
  name?: string
}

export interface AuthStatus {
  configured: boolean
  user: AuthUser | null
}

export type AuthErrorCode =
  | 'not-configured'
  | 'invalid-credentials'
  | 'email-not-confirmed'
  | 'email-taken'
  | 'invalid-code'
  | 'weak-password'
  | 'invalid-email'
  | 'email-send-failed'
  | 'rate-limited'
  | 'network'
  | 'server'
  | 'failed'

type Fail = { ok: false; error: AuthErrorCode; message: string }

export type SignUpResult = { ok: true; status: 'confirm' | 'signed-in' } | Fail
export type VerifyResult = { ok: true; user: AuthUser } | Fail
export type SignInResult = { ok: true; user: AuthUser } | Fail
export type SimpleResult = { ok: true } | Fail

// --- Supabase client (main process only) ------------------------------------

let client: SupabaseClient | null = null
let initialized = false

/**
 * A tiny file-backed storage so the session survives restarts. The Node main
 * process has no localStorage, so we persist Supabase's auth token to a small
 * file in the app's user-data folder — encrypted via Electron safeStorage
 * (macOS Keychain) and written owner-only (0600), mirroring google.ts's
 * refresh-token storage.
 */
function makeFileStorage(path: string): SupportedStorage {
  const canEncrypt = safeStorage.isEncryptionAvailable()
  let memory: Record<string, string> = {}
  try {
    const raw = readFileSync(path)
    // Harden pre-existing files: `mode` below only applies when a file is
    // CREATED, so a session file written world-readable before this fix would
    // otherwise keep its loose permissions forever.
    try {
      chmodSync(path, 0o600)
    } catch {
      /* best effort */
    }
    memory = JSON.parse(safeStorage.decryptString(raw)) as Record<string, string>
  } catch {
    // First run, unreadable, or undecryptable (old plaintext file / keychain
    // reset) — treat as no session; the user simply logs in again.
    memory = {}
  }
  const persist = (): void => {
    // Never write tokens we can't encrypt — the session just won't survive
    // a restart, which is safer than a plaintext token on disk.
    if (!canEncrypt) return
    // 0600: owner-only, defense-in-depth on top of the encryption.
    writeFile(path, safeStorage.encryptString(JSON.stringify(memory)), { mode: 0o600 }, () => {}) // best-effort async write
  }
  return {
    getItem: (key) => (key in memory ? memory[key] : null),
    setItem: (key, value) => {
      memory[key] = value
      persist()
    },
    removeItem: (key) => {
      delete memory[key]
      persist()
    }
  }
}

/** Build the client lazily (after app is ready). Returns null if no .env keys. */
function getClient(): SupabaseClient | null {
  if (initialized) return client
  initialized = true
  const url = process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_ANON_KEY?.trim()
  if (!url || !key) return null
  client = createClient(url, key, {
    auth: {
      storage: makeFileStorage(join(app.getPath('userData'), 'supabase-auth.json')),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false // desktop app: there is no URL to read a session from
    }
  })
  return client
}

// --- Accessors for the backup layer (main process only) ---------------------

/** The authenticated Supabase client (anon key + the signed-in user's session),
 *  or null if accounts aren't configured. The backup makes all its calls
 *  through THIS client, so every request carries the user's JWT and RLS applies
 *  — it never uses a service-role/admin key (there is none in the app). */
export function getSupabaseClient(): SupabaseClient | null {
  return getClient()
}

/** The signed-in user's id (to stamp backup rows), or null if not signed in. */
export async function getSignedInUserId(): Promise<string | null> {
  const c = getClient()
  if (!c) return null
  try {
    const { data } = await c.auth.getSession()
    return data.session?.user?.id ?? null
  } catch {
    return null
  }
}

// --- Helpers ----------------------------------------------------------------

function toAuthUser(user: User | null | undefined): AuthUser | null {
  if (!user || typeof user.id !== 'string') return null
  const meta = user.user_metadata as { full_name?: unknown } | undefined
  const name = typeof meta?.full_name === 'string' ? meta.full_name : undefined
  return { id: user.id, email: typeof user.email === 'string' ? user.email : '', name }
}

const NOT_CONFIGURED: Fail = {
  ok: false,
  error: 'not-configured',
  message:
    'User accounts aren’t set up yet. Add SUPABASE_URL and SUPABASE_ANON_KEY to your .env file and restart the app.'
}

/** Turn any Supabase/auth error into a calm, user-facing message. */
function mapError(err: unknown): Fail {
  if (err instanceof AuthError) {
    const code = (err as { code?: string }).code ?? ''
    const status = (err as { status?: number }).status
    const msg = typeof err.message === 'string' ? err.message.toLowerCase() : ''

    // Supabase returns a 500 "Error sending confirmation email" when the email
    // (SMTP) provider can't be reached — a setup issue, not the user's fault.
    if (msg.includes('sending') && msg.includes('email')) {
      return {
        ok: false,
        error: 'email-send-failed',
        message:
          'Your account was started, but the confirmation email couldn’t be sent. This is an email (SMTP) setup issue, not your connection.'
      }
    }
    if (err.name === 'AuthRetryableFetchError' || typeof status === 'number') {
      // A 5xx is a server-side problem (often email sending); only a missing
      // status / fetch failure is a genuine "can't reach the server".
      if (typeof status === 'number' && status >= 500) {
        return {
          ok: false,
          error: 'server',
          message:
            'The server couldn’t finish that — this often means confirmation emails aren’t sending (an email/SMTP setup issue). Please try again in a moment.'
        }
      }
    }
    if (err.name === 'AuthRetryableFetchError' || status === 0 || msg.includes('fetch failed')) {
      return {
        ok: false,
        error: 'network',
        message: 'Could not reach the server. Check your internet connection and try again.'
      }
    }
    switch (code) {
      case 'invalid_credentials':
        return {
          ok: false,
          error: 'invalid-credentials',
          message: 'That email or password is incorrect.'
        }
      case 'email_not_confirmed':
        return {
          ok: false,
          error: 'email-not-confirmed',
          message: 'Your email isn’t confirmed yet — enter the code we emailed you.'
        }
      case 'user_already_exists':
      case 'email_exists':
        return {
          ok: false,
          error: 'email-taken',
          message: 'An account with this email already exists. Try logging in instead.'
        }
      case 'weak_password':
        return {
          ok: false,
          error: 'weak-password',
          message: 'That password is too weak — use at least 6 characters.'
        }
      case 'email_address_invalid':
      case 'validation_failed':
        return {
          ok: false,
          error: 'invalid-email',
          message: 'That doesn’t look like a valid email address.'
        }
      case 'otp_expired':
        return {
          ok: false,
          error: 'invalid-code',
          message: 'That code is invalid or has expired. Request a new one.'
        }
      case 'over_email_send_rate_limit':
      case 'over_request_rate_limit':
      case 'too_many_requests':
        return {
          ok: false,
          error: 'rate-limited',
          message: 'Too many attempts. Please wait a minute, then try again.'
        }
    }
    // Fall back to message sniffing for errors without a clean code.
    if (
      msg.includes('expired') ||
      (msg.includes('invalid') && (msg.includes('token') || msg.includes('otp')))
    ) {
      return {
        ok: false,
        error: 'invalid-code',
        message: 'That code is invalid or has expired. Request a new one.'
      }
    }
    if (msg.includes('already registered') || msg.includes('already exists')) {
      return {
        ok: false,
        error: 'email-taken',
        message: 'An account with this email already exists. Try logging in instead.'
      }
    }
    return { ok: false, error: 'failed', message: 'Something went wrong. Please try again.' }
  }
  // Non-AuthError throw (e.g. a raw network failure).
  return {
    ok: false,
    error: 'network',
    message: 'Could not reach the server. Check your internet connection and try again.'
  }
}

function readBody(p: unknown): { email: string; password: string; name: string; token: string } {
  const b = (p ?? {}) as { email?: unknown; password?: unknown; name?: unknown; token?: unknown }
  return {
    email: typeof b.email === 'string' ? b.email.trim() : '',
    password: typeof b.password === 'string' ? b.password : '', // never trim a password
    name: typeof b.name === 'string' ? b.name.trim() : '',
    token: typeof b.token === 'string' ? b.token.trim() : ''
  }
}

// --- Actions ----------------------------------------------------------------

async function getStatus(): Promise<AuthStatus> {
  const c = getClient()
  if (!c) return { configured: false, user: null }
  try {
    const { data } = await c.auth.getSession()
    return { configured: true, user: toAuthUser(data.session?.user) }
  } catch {
    return { configured: true, user: null }
  }
}

async function signUp(p: unknown): Promise<SignUpResult> {
  const c = getClient()
  if (!c) return NOT_CONFIGURED
  const { email, password, name } = readBody(p)
  if (!email || !password) {
    return { ok: false, error: 'failed', message: 'Please enter your email and a password.' }
  }
  try {
    const { data, error } = await c.auth.signUp({
      email,
      password,
      options: name ? { data: { full_name: name } } : undefined
    })
    if (error) return mapError(error)
    // When the email is already registered, Supabase obfuscates by returning a
    // user with no identities (and sends no email). Treat that as "taken".
    const identities = data.user?.identities
    if (Array.isArray(identities) && identities.length === 0) {
      return {
        ok: false,
        error: 'email-taken',
        message: 'An account with this email already exists. Try logging in instead.'
      }
    }
    // If confirmations are off, Supabase returns a session and the user is
    // already logged in — the gate will swap to the app via the broadcast.
    if (data.session) return { ok: true, status: 'signed-in' }
    return { ok: true, status: 'confirm' }
  } catch (err) {
    return mapError(err)
  }
}

async function verifyOtp(p: unknown): Promise<VerifyResult> {
  const c = getClient()
  if (!c) return NOT_CONFIGURED
  const { email, token } = readBody(p)
  if (!email || !token) {
    return { ok: false, error: 'invalid-code', message: 'Enter the code we emailed you.' }
  }
  try {
    const { data, error } = await c.auth.verifyOtp({ email, token, type: 'signup' })
    if (error) return mapError(error)
    const user = toAuthUser(data.user)
    if (!user) {
      return {
        ok: false,
        error: 'invalid-code',
        message: 'That code didn’t work. Please try again.'
      }
    }
    return { ok: true, user }
  } catch (err) {
    return mapError(err)
  }
}

async function signIn(p: unknown): Promise<SignInResult> {
  const c = getClient()
  if (!c) return NOT_CONFIGURED
  const { email, password } = readBody(p)
  if (!email || !password) {
    return {
      ok: false,
      error: 'invalid-credentials',
      message: 'Please enter your email and password.'
    }
  }
  try {
    const { data, error } = await c.auth.signInWithPassword({ email, password })
    if (error) return mapError(error)
    const user = toAuthUser(data.user)
    if (!user) return { ok: false, error: 'failed', message: 'Login failed. Please try again.' }
    return { ok: true, user }
  } catch (err) {
    return mapError(err)
  }
}

async function resendCode(p: unknown): Promise<SimpleResult> {
  const c = getClient()
  if (!c) return NOT_CONFIGURED
  const { email } = readBody(p)
  if (!email) return { ok: false, error: 'failed', message: 'Enter your email first.' }
  try {
    const { error } = await c.auth.resend({ type: 'signup', email })
    if (error) return mapError(error)
    return { ok: true }
  } catch (err) {
    return mapError(err)
  }
}

async function signOut(): Promise<SimpleResult> {
  const c = getClient()
  if (!c) return { ok: true }
  try {
    await c.auth.signOut()
  } catch {
    /* Even if the network call fails, the local session is cleared. */
  }
  return { ok: true }
}

// --- Registration -----------------------------------------------------------

function broadcast(user: AuthUser | null): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('auth:changed', user)
  }
}

let registered = false

export function registerAuth(): void {
  if (registered) return
  registered = true

  const c = getClient() // create now — app is ready, so userData path is valid
  if (c) {
    // Keep the renderer in sync on login, logout, and token refresh.
    c.auth.onAuthStateChange((_event, session) => broadcast(toAuthUser(session?.user)))
  }

  ipcMain.handle('auth:getStatus', () => getStatus())
  ipcMain.handle('auth:signUp', (_e, p: unknown) => signUp(p))
  ipcMain.handle('auth:verifyOtp', (_e, p: unknown) => verifyOtp(p))
  ipcMain.handle('auth:signIn', (_e, p: unknown) => signIn(p))
  ipcMain.handle('auth:resendCode', (_e, p: unknown) => resendCode(p))
  ipcMain.handle('auth:signOut', () => signOut())
}
