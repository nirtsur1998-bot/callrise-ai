// AUDIT FIX (2026-08-24) — the document capability gate.
//
// This gate did not exist. `needsVision` was derived from `req.images` only,
// so a PDF passed resolveChain unfiltered and openai-compatible.ts:99 emitted
// an OpenAI-only `{type:'file'}` part to Groq / NVIDIA / Mistral / OpenRouter
// / Cerebras — none of which accept it. Each 400 was classified 'structural'
// and blacklisted that model, and on a fresh install every purpose shares the
// synthetic `legacy:<provider>` step, so one PDF attached in a Rise chat could
// take out live call coaching for four hours.
//
// Same fixture technique as resolveChain.vision.test.ts: a tiny controlled
// catalog so the filter mechanism is proven directly rather than inferred from
// the real catalog's current contents.
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
  {
    id: string
    providerId: string
    modelId: string
    supportsVision?: true
    supportsDocuments?: true
  }
> = {
  'fx-reads-pdf': {
    id: 'fx-reads-pdf',
    providerId: 'google',
    modelId: 'reads',
    supportsVision: true,
    supportsDocuments: true
  },
  // Sees images but cannot take a PDF — the case that proves the two
  // capabilities are genuinely separate rather than one flag wearing two
  // names. This is the shape the old code got wrong in the other direction.
  'fx-sees-only': {
    id: 'fx-sees-only',
    providerId: 'groq',
    modelId: 'sees-only',
    supportsVision: true
  },
  'fx-text-only': { id: 'fx-text-only', providerId: 'groq', modelId: 'text-only' }
}
vi.mock('../model-catalog', () => ({ catalogEntry: (id: string) => FIXTURE_CATALOG[id] }))

const { loadAppSettings } = await import('../../app-settings')
const { resolveChain, noCapableModelMessage } = await import('../complete-with-fallback')

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

describe('resolveChain({ needsDocument })', () => {
  it('keeps only catalog entries flagged supportsDocuments: true', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-text-only', 'fx-reads-pdf']))
    const { configured, capable } = resolveChain('assistant-chat', { needsDocument: true })
    expect(configured.map((s) => s.catalogId)).toEqual(['fx-text-only', 'fx-reads-pdf'])
    expect(capable.map((s) => s.catalogId)).toEqual(['fx-reads-pdf'])
  })

  it('an unflagged entry is NOT assumed to read documents (positive flag)', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-text-only']))
    const { configured, capable } = resolveChain('assistant-chat', { needsDocument: true })
    expect(configured).toHaveLength(1)
    expect(
      capable,
      'a model with no supportsDocuments flag was sent a PDF — every rejection ' +
        'blacklists that model for four hours across every purpose'
    ).toHaveLength(0)
  })

  it('vision and document capability are independent — seeing an image is not reading a PDF', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-sees-only']))
    expect(resolveChain('assistant-chat', { needsVision: true }).capable).toHaveLength(1)
    expect(resolveChain('assistant-chat', { needsDocument: true }).capable).toHaveLength(0)
  })

  it('legacy steps: Claude counts as document-capable, Cerebras does not', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments([]))
    process.env.ANTHROPIC_API_KEY = 'a'
    activeProviderId.current = 'anthropic'
    expect(
      resolveChain('assistant-chat', { needsDocument: true }).capable.some((s) =>
        s.catalogId.startsWith('legacy:anthropic')
      )
    ).toBe(true)

    process.env.CEREBRAS_API_KEY = 'c'
    activeProviderId.current = 'cerebras'
    expect(
      resolveChain('assistant-chat', { needsDocument: true }).capable.some((s) =>
        s.catalogId.startsWith('legacy:cerebras')
      ),
      'Cerebras is served by openai-compatible.ts, which sends OpenAI file ' +
        'parts to an API that does not implement them — every one is a 400'
    ).toBe(false)
  })

  it('without needsDocument a text-only entry is still perfectly usable (no over-filtering)', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments(['fx-text-only']))
    expect(resolveChain('assistant-chat').capable).toHaveLength(1)
  })
})

describe('noCapableModelMessage', () => {
  it('names PDFs, and does not steer the user into another gated path', () => {
    const msg = noCapableModelMessage({ needsDocument: true })
    expect(msg).toContain('PDF')
    expect(msg).toContain('paste the relevant text')
  })

  // The vision copy used to end "or send the file as text or PDF instead",
  // which pointed users at the exact ungated path that blacklisted their
  // models. PDFs are gated now, so that advice would only move the refusal
  // one step later even in the best case.
  it('the image refusal no longer recommends sending a PDF instead', () => {
    const msg = noCapableModelMessage({ needsVision: true })
    expect(msg).toContain('images')
    expect(
      msg.toLowerCase(),
      'the image refusal still steers the user into the PDF path'
    ).not.toContain('pdf instead')
  })
})
