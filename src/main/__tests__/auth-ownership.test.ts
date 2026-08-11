// Proves the actual production wiring: signOut is private to auth.ts, so
// this drives it the same way the renderer does, through the real
// ipcMain.handle registration registerAuth() installs (captured via a
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

const clearAllAiKeys = vi.fn(async () => {})
vi.mock('../ai-keys', () => ({ clearAllAiKeys }))
const disconnectGoogle = vi.fn(async () => ({ ok: true }))
vi.mock('../google', () => ({ disconnect: disconnectGoogle }))
const disconnectOutlook = vi.fn(async () => ({ ok: true }))
vi.mock('../outlook', () => ({ disconnect: disconnectOutlook }))

const mockAuth = {
  getSession: vi.fn(async () => ({ data: { session: null } })),
  signInWithPassword: vi.fn(),
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

beforeEach(() => {
  broadcastSends.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('signOut clears connected-service secrets', () => {
  it('disconnects Google, Outlook, and clears AI keys on every sign-out', async () => {
    await handlers['auth:signOut'](null)
    expect(disconnectGoogle).toHaveBeenCalledTimes(1)
    expect(disconnectOutlook).toHaveBeenCalledTimes(1)
    expect(clearAllAiKeys).toHaveBeenCalledTimes(1)
  })
})
