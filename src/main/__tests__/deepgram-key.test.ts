// BUG-146 — the Deepgram credential's checker.
//
// Deepgram powers live transcription, and until 2026-08-31 nothing in the app
// ever checked its key: no validateKey, no "Test key" button, no save-time
// probe. A wrong key was discovered MID-CALL by someone who had been shown a
// saved key and had therefore stopped looking.
//
// These tests drive the injected `fetchImpl` rather than a mocked global,
// because that is the seam the function already exposes (same shape as
// transcribeVoiceNote in assistant/voice-note.ts) — no module-registry tricks,
// so none of species 54's misclassification risk.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateDeepgramKey } from '../deepgram-key'

/** A fetch stub that records what it was called with. */
function stubFetch(response: Partial<Response> | Error): {
  impl: typeof fetch
  calls: Array<{ url: string; init: RequestInit | undefined }>
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const impl = vi.fn(async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit | undefined })
    if (response instanceof Error) throw response
    return response as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

const ok = { ok: true, status: 200 }

/** Narrow to the failure arm, loudly. `if (result.ok) throw` in every test
 *  reads as noise and hides which assertion actually mattered. */
function reasonOf(result: Awaited<ReturnType<typeof validateDeepgramKey>>): string {
  if (result.ok) throw new Error('expected a failed validation, got ok')
  return result.reason
}

describe('validateDeepgramKey', () => {
  it('a key Deepgram accepts is reported as working', async () => {
    const { impl } = stubFetch(ok)
    await expect(validateDeepgramKey('good-key', impl)).resolves.toEqual({ ok: true, models: [] })
  })

  it('asks Deepgram the question the live pipeline asks, the way it asks it', async () => {
    // The value of this check is that it authenticates the SAME WAY the thing
    // it predicts does. `Token <key>` is what transcription.ts's socket and
    // voice-note.ts's POST both send; a validator using a different scheme
    // could pass while the real path 401s.
    const { impl, calls } = stubFetch(ok)
    await validateDeepgramKey('  spaced-key  ', impl)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.deepgram.com/v1/auth/token')
    expect(calls[0].init?.method).toBe('GET')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Token spaced-key')
  })

  it('a rejected key is reported as rejected, and names where to fix it', async () => {
    const { impl } = stubFetch({ ok: false, status: 401 })
    expect(reasonOf(await validateDeepgramKey('bad-key', impl))).toMatch(/rejected/i)
  })

  it('an unreachable Deepgram is NOT reported as a bad key', async () => {
    // The distinction the user acts on: "your key is wrong" sends them to
    // regenerate a credential; "we could not reach Deepgram" does not. A
    // validator that conflates the two costs someone a working key.
    const { impl } = stubFetch(new TypeError('fetch failed'))
    const reason = reasonOf(await validateDeepgramKey('good-key', impl))
    expect(reason).toMatch(/could not reach/i)
    expect(reason).not.toMatch(/rejected/i)
  })

  it('an empty value asks for a key without spending a request', async () => {
    const { impl, calls } = stubFetch(ok)
    const result = await validateDeepgramKey('   ', impl)
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('a 5xx is called a Deepgram problem, not a key problem', async () => {
    const { impl } = stubFetch({ ok: false, status: 503 })
    const reason = reasonOf(await validateDeepgramKey('good-key', impl))
    expect(reason).toMatch(/server error/i)
    expect(reason).not.toMatch(/rejected this key\./i)
  })
})

describe('THE COUPLING: the 429 wording is load-bearing, not prose', () => {
  // `deriveStatusDot` in the RENDERER classifies a failure by running a
  // rate-limit regex over the reason string produced HERE, in main. That makes
  // these words part of another module's control flow — a string match across a
  // boundary, which fails OPEN (species 47): reword this and a rate-limited key
  // silently renders a red "Key invalid" dot, sending someone to replace a key
  // that is fine.
  //
  // Main must not IMPORT renderer code (tsconfig.node.json has no @renderer
  // mapping, deliberately), so this reads the other module as TEXT and lifts
  // its actual regex out — the same technique provider-lockstep.test.ts uses to
  // check the preload bridge. The extraction refuses rather than guesses, so a
  // refactor that moves the classifier fails this test loudly instead of
  // quietly passing against a regex that is no longer the real one.
  const APIKEYS = join(
    __dirname,
    '..',
    '..',
    'renderer',
    'src',
    'features',
    'settings',
    'ApiKeysSection.tsx'
  )

  function rateLimitRegexFromRenderer(): RegExp {
    const src = readFileSync(APIKEYS, 'utf8')
    const m = src.match(/return (\/[^/\n]+\/i)\.test\(testResult\.message\)/)
    if (!m) {
      throw new Error(
        'Could not find the rate-limit classifier in ApiKeysSection.tsx. It was ' +
          '`return /rate.?limit/i.test(testResult.message)`. If it moved or ' +
          'changed shape, update this extraction — do NOT delete this test: it ' +
          'is the only thing tying deepgram-key.ts\u2019s wording to the dot that ' +
          'wording drives.'
      )
    }
    const [, body, flags] = m[1].match(/^\/(.+)\/([a-z]*)$/) as RegExpMatchArray
    return new RegExp(body, flags)
  }

  it('the renderer really does classify by matching the reason text', () => {
    // The control (species 37): prove the extraction found a real, working
    // classifier before trusting the two verdicts below.
    const rx = rateLimitRegexFromRenderer()
    expect(rx.test('Rate limited, try again shortly.')).toBe(true)
    expect(rx.test('Your key was rejected.')).toBe(false)
  })

  it('a rate-limited Deepgram key matches it, so the dot reads "Rate limited"', async () => {
    const { impl } = stubFetch({ ok: false, status: 429 })
    const reason = reasonOf(await validateDeepgramKey('good-key', impl))
    expect(rateLimitRegexFromRenderer().test(reason)).toBe(true)
  })

  it('a REJECTED Deepgram key does NOT, so the two stay apart', async () => {
    const { impl } = stubFetch({ ok: false, status: 401 })
    const reason = reasonOf(await validateDeepgramKey('bad-key', impl))
    expect(rateLimitRegexFromRenderer().test(reason)).toBe(false)
  })
})
