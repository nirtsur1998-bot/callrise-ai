// M28 Part 3 — the vision capability gate. Same fixture technique as
// resolveChain.capability.test.ts: a tiny controlled catalog so the filter
// mechanism is proven directly. supportsVision is a POSITIVE flag (undefined
// = cannot see), and legacy steps (Claude/ChatGPT, no catalog entries) are
// covered by the provider set.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const activeProviderId = { current: null as string | null }

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({
  getActiveAIProvider: () => (activeProviderId.current ? { id: activeProviderId.current } : null)
}))
vi.mock('../registry', () => {
  const make = (id: string, keyEnvName: string) => ({
    displayName: id,
    keyEnvName,
    build: () => ({ id, complete: async () => ({ text: 'ok', model: 'm', usage: {} }) })
  })
  return {
    PROVIDER_REGISTRY: {
      groq: make('groq', 'GROQ_API_KEY'),
      google: make('google', 'GOOGLE_AI_API_KEY'),
      anthropic: make('anthropic', 'ANTHROPIC_API_KEY'),
      // BUG-125 — added because the fixture could not previously express the
      // field case at all: a KEYED, vision-capable provider that is not the
      // active one. Without it the registry loop has nothing to find.
      openai: make('openai', 'OPENAI_API_KEY'),
      cerebras: make('cerebras', 'CEREBRAS_API_KEY')
    }
  }
})

const FIXTURE_CATALOG: Record<
  string,
  { id: string; providerId: string; modelId: string; supportsVision?: true }
> = {
  'fx-sees': { id: 'fx-sees', providerId: 'google', modelId: 'sees', supportsVision: true },
  'fx-blind': { id: 'fx-blind', providerId: 'groq', modelId: 'blind' }
}
vi.mock('../model-catalog', () => ({ catalogEntry: (id: string) => FIXTURE_CATALOG[id] }))

const { loadAppSettings } = await import('../../app-settings')
const { resolveChain } = await import('../complete-with-fallback')

function assignments(chain: string[]): ReturnType<typeof loadAppSettings> {
  return {
    aiModelAssignments: { 'assistant-chat': { chain } }
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  activeProviderId.current = null
  process.env.GROQ_API_KEY = 'g'
  process.env.GOOGLE_AI_API_KEY = 'goo'
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.CEREBRAS_API_KEY
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('resolveChain({ needsVision })', () => {
  it('keeps only catalog entries flagged supportsVision: true', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-blind', 'fx-sees']))
    const { configured, capable } = resolveChain('assistant-chat', { needsVision: true })
    expect(configured.map((s) => s.catalogId)).toEqual(['fx-blind', 'fx-sees'])
    expect(capable.map((s) => s.catalogId)).toEqual(['fx-sees'])
  })

  it('an unflagged entry is NOT assumed to see (positive flag, unlike tool-calling)', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-blind']))
    const { configured, capable } = resolveChain('assistant-chat', { needsVision: true })
    expect(configured).toHaveLength(1)
    // Asserts what this test is ACTUALLY about: the unflagged entry is
    // filtered out. It used to assert `capable.length === 0`, which bundled in
    // a second claim — "and there is no fallback either" — that BUG-125
    // deliberately changes: a keyed vision-capable provider IS now offered.
    expect(capable.some((s) => s.catalogId === 'fx-blind')).toBe(false)
  })

  it('legacy steps: Claude counts as vision-capable, Cerebras does not', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments([]))
    process.env.ANTHROPIC_API_KEY = 'a'
    activeProviderId.current = 'anthropic'
    expect(
      resolveChain('assistant-chat', { needsVision: true }).capable.some((s) =>
        s.catalogId.startsWith('legacy:anthropic')
      )
    ).toBe(true)

    process.env.CEREBRAS_API_KEY = 'c'
    activeProviderId.current = 'cerebras'
    expect(
      resolveChain('assistant-chat', { needsVision: true }).capable.some((s) =>
        s.catalogId.startsWith('legacy:cerebras')
      )
    ).toBe(false)
  })

  it('without needsVision the blind entry is still perfectly usable (no over-filtering)', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-blind']))
    expect(resolveChain('assistant-chat').capable).toHaveLength(1)
  })
})

// BUG-125 (2026-08-27) — THE FIELD FAILURE. The founder attached an image with
// ChatGPT, Groq, OpenRouter and Gemini all keyed, and got "every configured
// model failed to respond" after exactly ONE attempt: google-gemini-flash,
// timed out. A paid OpenAI key was never tried.
//
// Cause: assistant-chat's QUALITY_CHAIN has exactly one vision-capable entry,
// so the vision filter collapses nine models to one; and OpenAI/Anthropic have
// no catalog entries at all, so they are reachable ONLY as the legacy step —
// which is built from the ACTIVE provider alone. A paid vision-capable key is
// therefore unusable for vision unless it also happens to be the active one.
describe('BUG-125 — capability fallbacks reach every KEYED capable provider', () => {
  it('a keyed OpenAI key is offered for vision even when it is NOT the active provider', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-sees']))
    activeProviderId.current = 'groq' // active provider cannot see
    process.env.OPENAI_API_KEY = 'paid-key'

    const { capable } = resolveChain('assistant-chat', { needsVision: true })
    expect(
      capable.some((s) => s.catalogId === 'legacy:openai'),
      'the paid OpenAI key was unreachable for vision because it was not the ' +
        'active provider — the exact field failure'
    ).toBe(true)
  })

  it('the free-tier catalog entry still goes FIRST — cost posture unchanged', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-sees']))
    activeProviderId.current = 'groq'
    process.env.OPENAI_API_KEY = 'paid-key'

    const { capable } = resolveChain('assistant-chat', { needsVision: true })
    expect(capable[0].catalogId).toBe('fx-sees')
    expect(capable[capable.length - 1].catalogId).toBe('legacy:openai')
  })

  it('a keyed provider that CANNOT see is never added', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-sees']))
    activeProviderId.current = null
    process.env.CEREBRAS_API_KEY = 'c' // keyed, but not vision-capable
    delete process.env.OPENAI_API_KEY

    const { capable } = resolveChain('assistant-chat', { needsVision: true })
    expect(capable.some((s) => s.catalogId === 'legacy:cerebras')).toBe(false)
  })

  it('an UNKEYED capable provider is never added — a key is the whole point', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-sees']))
    activeProviderId.current = null
    delete process.env.OPENAI_API_KEY
    delete process.env.ANTHROPIC_API_KEY

    const { capable } = resolveChain('assistant-chat', { needsVision: true })
    expect(capable.some((s) => s.catalogId.startsWith('legacy:'))).toBe(false)
  })

  it('an ORDINARY text turn is NOT widened — this must not touch the normal path', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-blind']))
    activeProviderId.current = 'groq'
    process.env.OPENAI_API_KEY = 'paid-key'

    // No capability need at all.
    const { capable } = resolveChain('assistant-chat')
    expect(capable.map((s) => s.catalogId)).toEqual(['fx-blind'])
  })

  it('documents get the same treatment as images', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments([]))
    activeProviderId.current = 'groq'
    process.env.OPENAI_API_KEY = 'paid-key'

    const { capable } = resolveChain('assistant-chat', { needsDocument: true })
    expect(capable.some((s) => s.catalogId === 'legacy:openai')).toBe(true)
  })
})
