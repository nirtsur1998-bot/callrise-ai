// BUG-022 — this device's local data belongs to exactly one account. Proves
// the actual production wiring: signIn/signOut are private to auth.ts, so
// this drives them the same way the renderer does, through the real
// ipcMain.handle registrations registerAuth() installs (captured via a
// mocked electron, same pattern as active-app.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Record<string, Handler> = {}
const broadcastSends: { channel: string; payload: unknown }[] = []

vi.mock('electron', () => ({
  app: { getPath: () => '/fake/userdata' },
  ipcMain: {
    handle: (name: string, fn: Handler) => {
      handlers[name] = fn
    }
  },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => broadcastSends.push({ channel, payload })
        }
      }
    ]
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))

let ownerId: string | null = null
vi.mock('../device-owner', () => ({
  readOwner: vi.fn(async () => ownerId),
  claimOwnershipIfUnset: vi.fn(async () => {})
}))

const wipeDeviceLocalData = vi.fn(async () => {})
vi.mock('../device-reset', () => ({ wipeDeviceLocalData }))

const clearAllAiKeys = vi.fn(async () => {})
vi.mock('../ai-keys', () => ({ clearAllAiKeys }))
const disconnectGoogle = vi.fn(async () => ({ ok: true }))
vi.mock('../google', () => ({ disconnect: disconnectGoogle }))
const disconnectOutlook = vi.fn(async () => ({ ok: true }))
vi.mock('../outlook', () => ({ disconnect: disconnectOutlook }))

let sessionUser: { id: string; email: string } | null = null
const mockAuth = {
  getSession: vi.fn(async () => ({ data: { session: sessionUser ? { user: sessionUser } : null } })),
  signInWithPassword: vi.fn(async () => ({
    data: { user: sessionUser, session: sessionUser ? { user: sessionUser } : null },
    error: null
  })),
  signOut: vi.fn(async () => ({ error: null })),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: () => {} } } })),
  signUp: vi.fn(),
  verifyOtp: vi.fn(),
  resend: vi.fn(),
  updateUser: vi.fn()
}
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: mockAuth })),
  AuthError: class AuthError extends Error {}
}))

process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_ANON_KEY = 'test-anon-key'

const { registerAuth } = await import('../auth')
registerAuth()

const OWNER = { id: 'user-owner', email: 'owner@example.com' }
const OTHER = { id: 'user-other', email: 'other@example.com' }

beforeEach(() => {
  ownerId = null
  sessionUser = null
  broadcastSends.length = 0
  mockAuth.signOut.mockClear()
  mockAuth.signInWithPassword.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('signIn ownership guard', () => {
  it('succeeds when no owner is set yet (fresh device)', async () => {
    ownerId = null
    sessionUser = OTHER
    const result = await handlers['auth:signIn'](null, { email: OTHER.email, password: 'x' })
    expect(result).toMatchObject({ ok: true, user: { id: OTHER.id } })
    expect(mockAuth.signOut).not.toHaveBeenCalled()
  })

  it('succeeds when the signing-in account IS the owner', async () => {
    ownerId = OWNER.id
    sessionUser = OWNER
    const result = await handlers['auth:signIn'](null, { email: OWNER.email, password: 'x' })
    expect(result).toMatchObject({ ok: true, user: { id: OWNER.id } })
    expect(mockAuth.signOut).not.toHaveBeenCalled()
  })

  it('refuses and reverses the sign-in when a DIFFERENT account already owns this device', async () => {
    ownerId = OWNER.id
    sessionUser = OTHER
    const result = await handlers['auth:signIn'](null, { email: OTHER.email, password: 'x' })
    expect(result).toMatchObject({ ok: false, error: 'device-owned-by-other-account' })
    // The sign-in must be undone, not just refused — the caller returned
    // ok:false, but Supabase itself had already authenticated the request.
    expect(mockAuth.signOut).toHaveBeenCalledTimes(1)
  })
})

describe('getStatus ownership guard (session restored on launch)', () => {
  it('returns the user when there is no conflict', async () => {
    ownerId = OWNER.id
    sessionUser = OWNER
    const status = await handlers['auth:getStatus'](null)
    expect(status).toMatchObject({ configured: true, user: { id: OWNER.id } })
  })

  it('returns null and signs out a session belonging to a non-owner account', async () => {
    ownerId = OWNER.id
    sessionUser = OTHER
    const status = await handlers['auth:getStatus'](null)
    expect(status).toEqual({ configured: true, user: null })
    expect(mockAuth.signOut).toHaveBeenCalledTimes(1)
  })

  it('returns null with no session, without touching signOut', async () => {
    ownerId = OWNER.id
    sessionUser = null
    const status = await handlers['auth:getStatus'](null)
    expect(status).toEqual({ configured: true, user: null })
    expect(mockAuth.signOut).not.toHaveBeenCalled()
  })
})

describe('signOut clears connected-service secrets', () => {
  it('disconnects Google, Outlook, and clears AI keys on every sign-out', async () => {
    await handlers['auth:signOut'](null)
    expect(disconnectGoogle).toHaveBeenCalledTimes(1)
    expect(disconnectOutlook).toHaveBeenCalledTimes(1)
    expect(clearAllAiKeys).toHaveBeenCalledTimes(1)
  })
})

describe('auth:wipeDeviceData', () => {
  it('delegates to wipeDeviceLocalData and reports success', async () => {
    const result = await handlers['auth:wipeDeviceData'](null)
    expect(wipeDeviceLocalData).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true })
  })
})
