// BUG-057 Phase 6 — pre-call tool-calling capability check. CatalogEntry has
// no live signal for this (listModels() returns ID strings only), so
// supportsToolCalling is a static, hand-verified flag, same convention as
// knownStale. resolveChain(purpose, {needsTool}) returns BOTH `configured`
// (every step with a key, unfiltered) and `capable` (further filtered when
// needsTool is set) so a caller can tell "no keys at all" apart from "keys
// exist but none support tools" — the first design pass's version filtered
// internally and then re-ran the same already-filtered check, which could
// never fire. These tests mock ../model-catalog with tiny fixtures for full
// control over the capable/incapable split; the REAL catalog now has one
// supportsToolCalling:false entry (openrouter-auto-free, M27 B2), covered
// separately against the real data in model-catalog.b2.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIProviderError } from '../types'

const activeProviderId = { current: null as string | null }
const built: string[] = []

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))
vi.mock('../registry', () => {
  const make = (id: string, keyEnvName: string) => ({
    displayName: id,
    keyEnvName,
    build: () => ({
      id,
      complete: async () => {
        built.push(id)
        return { text: 'ok', model: 'm', usage: {} }
      }
    })
  })
  return {
    PROVIDER_REGISTRY: {
      groq: make('groq', 'GROQ_API_KEY'),
      google: make('google', 'GOOGLE_AI_API_KEY')
    }
  }
})

// A tiny, fully-controlled fixture catalog — the claim under test (the
// filter mechanism itself) is proven most cleanly against a two-entry
// capable/incapable pair rather than the real catalog's churn. The real
// openrouter-auto-free:false entry is asserted against production data in
// model-catalog.b2.test.ts.
const FIXTURE_CATALOG: Record<string, { id: string; providerId: string; modelId: string; supportsToolCalling?: false }> = {
  'fixture-capable': { id: 'fixture-capable', providerId: 'groq', modelId: 'capable-model' },
  'fixture-incapable': {
    id: 'fixture-incapable',
    providerId: 'google',
    modelId: 'incapable-model',
    supportsToolCalling: false
  }
}
vi.mock('../model-catalog', () => ({
  catalogEntry: (id: string) => FIXTURE_CATALOG[id]
}))

const { loadAppSettings } = await import('../../app-settings')
const { completeWithFallback, streamWithFallback, resolveChain, resetToolExclusionLogForTests } =
  await import('../complete-with-fallback')
const { resetCooldownsForTests } = await import('../model-cooldown')
const { resetPacingForTests } = await import('../model-pacing')
const { logFallbackEvent } = await import('../fallback-log')

function assignments(purpose: string, chain: string[]): ReturnType<typeof loadAppSettings> {
  return {
    aiModelAssignments: {
      'coaching-cue': { chain: [] },
      summary: { chain: [] },
      scorecard: { chain: [] },
      tasks: { chain: [] },
      other: { chain: [] },
      'prep-brief': { chain: [] },
      'deal-tier1': { chain: [] },
      'deal-tier2': { chain: [] },
      'coaching-chat': { chain: [] },
      'memory-extract': { chain: [] },
      'memory-consolidate': { chain: [] },
      'memory-reflect': { chain: [] },
      [purpose]: { chain }
    }
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  resetCooldownsForTests()
  resetPacingForTests()
  resetToolExclusionLogForTests()
  vi.mocked(logFallbackEvent).mockClear()
  built.length = 0
  activeProviderId.current = null
  process.env.GROQ_API_KEY = 'g'
  process.env.GOOGLE_AI_API_KEY = 'goo'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('resolveChain(purpose, {needsTool}) — the capable/configured split', () => {
  it('needsTool omitted: capable equals configured exactly, including the incapable entry', () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      assignments('summary', ['fixture-capable', 'fixture-incapable'])
    )
    const { configured, capable } = resolveChain('summary')
    expect(configured.map((s) => s.catalogId)).toEqual(['fixture-capable', 'fixture-incapable'])
    expect(capable).toEqual(configured)
  })

  it('needsTool: true excludes the incapable entry from capable but NOT from configured', () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      assignments('summary', ['fixture-capable', 'fixture-incapable'])
    )
    const { configured, capable } = resolveChain('summary', { needsTool: true })
    expect(configured.map((s) => s.catalogId)).toEqual(['fixture-capable', 'fixture-incapable'])
    expect(capable.map((s) => s.catalogId)).toEqual(['fixture-capable'])
  })

  it('every configured entry incapable: configured is non-empty, capable is empty — the distinction the first-pass guard could never reach', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments('summary', ['fixture-incapable']))
    const { configured, capable } = resolveChain('summary', { needsTool: true })
    expect(configured.length).toBe(1)
    expect(capable.length).toBe(0)
  })

  it('an entry with supportsToolCalling left undefined is treated as capable, unverified-but-assumed', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments('summary', ['fixture-capable']))
    const { capable } = resolveChain('summary', { needsTool: true })
    expect(capable.map((s) => s.catalogId)).toEqual(['fixture-capable'])
  })
})

describe('completeWithFallback — the capability-exhausted error, through the real walk', () => {
  it('throws a DISTINCT capability message, not the no-key message, when keys exist but nothing is capable', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments('summary', ['fixture-incapable']))

    const err = await completeWithFallback({
      purpose: 'summary',
      tool: { name: 't', description: 'd', inputSchema: {} },
      messages: []
    } as never).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(AIProviderError)
    expect((err as AIProviderError).code).toBe('failed')
    expect((err as AIProviderError).message).toMatch(/tool-calling not supported/i)
    expect((err as AIProviderError).message).not.toMatch(/no ai provider is configured/i)
    expect(built).toEqual([]) // never even attempted — refused before spending a request
  })

  it('does not throw the capability error when req.tool is not set — capability only matters for forced-tool requests', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments('summary', ['fixture-incapable']))

    const result = await completeWithFallback({
      purpose: 'summary',
      messages: []
    } as never)

    // No tool requested -> needsTool is false -> capable === configured ->
    // the "incapable" entry is attempted anyway, since capability never
    // mattered for this call.
    //
    // HONEST LIMITATION: this doesn't discriminate Phase 6 on its own — the
    // pre-Phase-6 code attempts this entry too, since capability filtering
    // never existed at all. It's a real boundary/regression test (the
    // filter must not over-apply to calls that never asked for a tool),
    // just not red-check-provable in isolation; the "needsTool: true"
    // tests above are what prove the filter exists.
    expect(result.text).toBe('ok')
    expect(built).toEqual(['google'])
  })

  it('skips the incapable entry and attempts only the capable one when both are configured', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      assignments('summary', ['fixture-incapable', 'fixture-capable'])
    )

    const result = await completeWithFallback({
      purpose: 'summary',
      tool: { name: 't', description: 'd', inputSchema: {} },
      messages: []
    } as never)

    expect(result.text).toBe('ok')
    expect(built).toEqual(['groq']) // fixture-incapable's provider (google) never attempted
  })
})

// BUG-057 Phase 6 follow-up — the flag's own doc comment (model-catalog.ts)
// names the staleness risk exactly: a `false` entry that's gone stale (the
// provider now supports tools) stays "silently excluded with no error and no
// log line." These prove the exclusion now surfaces in fallback-log.ts, the
// same place every other fallback decision does, so a stale flag is
// diagnosable from Settings → Model Assignment instead of invisible.
describe('a tool-calling exclusion is logged (once) so a stale flag is diagnosable', () => {
  it('logs the excluded model to the fallback event log when needsTool drops it', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      assignments('summary', ['fixture-capable', 'fixture-incapable'])
    )

    await completeWithFallback({
      purpose: 'summary',
      tool: { name: 't', description: 'd', inputSchema: {} },
      messages: []
    } as never)

    const exclusionLogs = vi
      .mocked(logFallbackEvent)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.reason.startsWith('skipped: tool-calling'))
    expect(exclusionLogs).toHaveLength(1)
    expect(exclusionLogs[0].fromCatalogId).toBe('fixture-incapable')
    expect(exclusionLogs[0].purpose).toBe('summary')
  })

  it('does NOT log when needsTool is false — capability never applied, nothing was excluded', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments('summary', ['fixture-incapable']))

    await completeWithFallback({ purpose: 'summary', messages: [] } as never)

    const exclusionLogs = vi
      .mocked(logFallbackEvent)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.reason.startsWith('skipped: tool-calling'))
    expect(exclusionLogs).toHaveLength(0)
  })

  it('deduplicates — a second call excluding the same model in the same session logs nothing new', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      assignments('summary', ['fixture-capable', 'fixture-incapable'])
    )
    const req = {
      purpose: 'summary',
      tool: { name: 't', description: 'd', inputSchema: {} },
      messages: []
    } as never

    // The exclusion is logged at resolveChain time, BEFORE any pacing/cooldown
    // decision — so the second call's outcome (the capable model is paced off
    // by Phase 1 after the first call just used it, moments earlier in real
    // time) is irrelevant to what's under test here; tolerate the throw.
    await completeWithFallback(req).catch(() => {})
    await completeWithFallback(req).catch(() => {})

    const exclusionLogs = vi
      .mocked(logFallbackEvent)
      .mock.calls.map((c) => c[0])
      .filter((e) => e.reason.startsWith('skipped: tool-calling'))
    // Coaching-cue re-resolves every ~2.5s mid-call — this is what keeps the
    // exclusion from spamming the 1000-entry cap and evicting real history.
    expect(exclusionLogs).toHaveLength(1)
  })
})

describe('streamWithFallback — the same capability-exhausted error, through the real walk', () => {
  it('throws a DISTINCT capability message, not the no-key message', async () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments('coaching-chat', ['fixture-incapable']))

    const gen = streamWithFallback({
      purpose: 'coaching-chat',
      tool: { name: 't', description: 'd', inputSchema: {} },
      messages: []
    } as never)

    // streamWithFallback rejects TWO things on failure: the async generator
    // itself (caught below) and its separate `final` promise (rejectFinal) —
    // left unattached, that second rejection surfaces as an unhandled
    // rejection next to an otherwise-green run (the exact "stray error
    // line" pattern the M26 taxonomy catalogues — caught here by reading
    // the actual test output, not assumed clean because assertions passed).
    gen.final.catch(() => {})
    const err = await (async () => {
      try {
        for await (const _ of gen) void _
        return null
      } catch (e) {
        return e
      }
    })()

    expect(err).toBeInstanceOf(AIProviderError)
    expect((err as AIProviderError).message).toMatch(/tool-calling not supported/i)
    expect(built).toEqual([])
  })
})
