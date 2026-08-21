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
    expect(capable).toHaveLength(0) // keys exist, nothing can read an image
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
