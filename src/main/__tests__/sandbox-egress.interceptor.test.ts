// @vitest-environment node
//
// BUG-263 — the classifier decides; THIS proves the decision is actually
// applied to a request that was really about to leave.
//
// The distinction matters because the bug being fixed was precisely a correct
// mechanism with no reach: `backupRefusedForSandbox()` returned the right
// answer every time and two functions asked it. A decision table with no
// interceptor would be the same bug with better tests.
//
// Every assertion here also checks the REFUSAL COUNT, not just the absence of a
// request. "No request left" and "this code never ran" produce identical
// evidence otherwise.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  installSandboxEgressGuard,
  resetSandboxEgressForTests,
  sandboxRefusals,
  SandboxEgressRefused
} from '../sandbox-egress'

let uninstall: (() => void) | null = null

beforeEach(() => {
  resetSandboxEgressForTests()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  uninstall?.()
  uninstall = null
  resetSandboxEgressForTests()
  vi.restoreAllMocks()
})

describe('BUG-263 — the fetch patch', () => {
  it('rejects a refused host and never calls through', async () => {
    const realFetch = vi.fn().mockResolvedValue(new Response('should not happen'))
    globalThis.fetch = realFetch as unknown as typeof fetch
    uninstall = installSandboxEgressGuard(new Set())

    await expect(fetch('https://graph.microsoft.com/v1.0/me/events')).rejects.toBeInstanceOf(
      SandboxEgressRefused
    )

    expect(realFetch, 'the real fetch must never be reached').not.toHaveBeenCalled()
    // The work count. Without this, a guard that refused nothing because the
    // patch was never installed would also produce zero requests.
    expect(sandboxRefusals()).toHaveLength(1)
    expect(sandboxRefusals()[0].category).toBe('calendar')
    expect(sandboxRefusals()[0].host).toBe('graph.microsoft.com')
  })

  it('calls through for an allowed host, and counts no refusal', async () => {
    // The paired control. A patch that rejected EVERYTHING would satisfy every
    // assertion above and break the app completely.
    const realFetch = vi.fn().mockResolvedValue(new Response('ok'))
    globalThis.fetch = realFetch as unknown as typeof fetch
    uninstall = installSandboxEgressGuard(new Set(['calendar']))

    await fetch('https://graph.microsoft.com/v1.0/me/events')

    expect(realFetch).toHaveBeenCalledTimes(1)
    expect(sandboxRefusals()).toHaveLength(0)
  })

  it('reads the URL off a Request object, not only a string', async () => {
    // `fetch(new Request(url))` is what several SDKs do. A patch that only
    // understood strings would classify `undefined`, refuse it as unparseable,
    // and look like it was working.
    const realFetch = vi.fn().mockResolvedValue(new Response('ok'))
    globalThis.fetch = realFetch as unknown as typeof fetch
    uninstall = installSandboxEgressGuard(new Set(['sync']))

    await fetch(new Request('https://p.supabase.co/rest/v1/calls'))
    expect(realFetch).toHaveBeenCalledTimes(1)

    await expect(fetch(new Request('https://api.telegram.org/bot1/x'))).rejects.toBeInstanceOf(
      SandboxEgressRefused
    )
    expect(sandboxRefusals().map((r) => r.category)).toEqual(['alerts'])
  })

  it('reads the URL off a URL object', async () => {
    const realFetch = vi.fn().mockResolvedValue(new Response('ok'))
    globalThis.fetch = realFetch as unknown as typeof fetch
    uninstall = installSandboxEgressGuard(new Set(['ai']))
    await fetch(new URL('https://api.anthropic.com/v1/messages'))
    expect(realFetch).toHaveBeenCalledTimes(1)
  })
})

describe('BUG-263 — the node http/https patch', () => {
  it('throws on a refused host before any socket is opened', async () => {
    uninstall = installSandboxEgressGuard(new Set())
    const https = await import('node:https')
    expect(() => https.request('https://api.telegram.org/bot1/sendMessage')).toThrow(
      SandboxEgressRefused
    )
    expect(sandboxRefusals()).toHaveLength(1)
    expect(sandboxRefusals()[0].category).toBe('alerts')
  })

  it('understands the options-object overload, not only a URL string', async () => {
    // `ws` and gaxios both call https.request({ hostname, path, … }). A patch
    // that only handled the string form would let exactly those through — and
    // `ws` is the Deepgram audio socket.
    uninstall = installSandboxEgressGuard(new Set())
    const https = await import('node:https')
    expect(() =>
      https.request({
        hostname: 'api.deepgram.com',
        path: '/v1/listen?model=nova-3',
        method: 'GET'
      })
    ).toThrow(SandboxEgressRefused)
    expect(sandboxRefusals()[0].category).toBe('transcription')
  })

  it('lets loopback through so the dev server and CDP keep working', async () => {
    uninstall = installSandboxEgressGuard(new Set())
    const http = await import('node:http')
    // Not asserting the response — only that the guard did not throw, and that
    // it recorded no refusal.
    const req = http.request({ hostname: '127.0.0.1', port: 1, path: '/' })
    req.on('error', () => undefined)
    req.destroy()
    expect(sandboxRefusals()).toHaveLength(0)
  })

  it('restores the originals on uninstall', async () => {
    // Compared through `.default` — the CJS module object — NOT through the
    // namespace's named exports.
    //
    // Found by this assertion failing: `import * as https from 'node:https'`
    // snapshots its named exports, so `https.request` keeps pointing at the
    // ORIGINAL function even while `require('node:https').request` is patched.
    // Only `https.default.request` and `https.request(...)`-via-CJS see it.
    //
    // That is a real hole, not a test artefact, and its size was measured
    // rather than assumed: `grep` for node http/https imports across
    // `src/main` returns three files, and all three import `createServer`
    // (the OAuth loopback listener — a server, not egress). No first-party
    // code calls `request`/`get` at all. The patch exists for the third-party
    // clients — `ws`, gaxios, supabase-js — which are CJS and read the live
    // object. See the canary for what that is worth in practice.
    const mod = (await import('node:https')).default
    const before = mod.request
    const un = installSandboxEgressGuard(new Set())
    expect(mod.request).not.toBe(before)
    un()
    expect(mod.request).toBe(before)
  })
})
