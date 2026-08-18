// M27 B2 — the two chronically-failing OpenRouter catalog entries, fixed
// against this app's OWN real fallback-log evidence plus a live check of
// OpenRouter's /api/v1/models on 2026-08-14:
//   - openrouter-nemotron-3-ultra (modelId nvidia/nemotron-3-ultra:free) 400'd
//     on 100% of the 23 times it was tried, because that model id no longer
//     exists on OpenRouter at all — REPLACED with the current
//     nvidia/nemotron-3.5-lightning:free (verified present and tool-capable).
//   - openrouter-auto-free failed 28 of 39 real attempts on tool-call output —
//     marked supportsToolCalling:false so it's excluded from tool chains only,
//     kept as a plain-text last resort.
//
// These run against the REAL MODEL_CATALOG (not fixtures), because the claim
// under test is specifically that the production data is correct now.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({ getActiveAIProvider: () => null }))

const { loadAppSettings } = await import('../../app-settings')
const { MODEL_CATALOG, catalogEntry } = await import('../model-catalog')
const { resolveChain, DEFAULT_CATALOG_CHAIN } = await import('../complete-with-fallback')

const ALL_PURPOSES = [
  'coaching-cue', 'summary', 'scorecard', 'tasks', 'other', 'prep-brief',
  'deal-tier1', 'deal-tier2', 'coaching-chat', 'memory-extract',
  'memory-consolidate', 'memory-reflect'
]

function assignments(purpose: string, chain: string[]): ReturnType<typeof loadAppSettings> {
  return {
    aiModelAssignments: Object.fromEntries(
      ALL_PURPOSES.map((p) => [p, { chain: p === purpose ? chain : [] }])
    )
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('M27 B2 — catalog data pins', () => {
  it('the dead nvidia/nemotron-3-ultra:free modelId (100% 400s) is gone from the catalog entirely', () => {
    // HONEST about what this proves: the catalog DATA changed, not that the
    // replacement works live (that's resolveCatalog's job against a real key).
    // Pins that the dead id never silently reappears in a future edit.
    expect(MODEL_CATALOG.some((e) => e.modelId === 'nvidia/nemotron-3-ultra:free')).toBe(false)
    expect(catalogEntry('openrouter-nemotron-3-ultra')).toBeUndefined()
  })

  it('the replacement Nemotron 3.5 Lightning entry exists, tool-capable, on the openrouter provider', () => {
    const entry = catalogEntry('openrouter-nemotron-3.5-lightning')
    expect(entry).toBeDefined()
    expect(entry?.modelId).toBe('nvidia/nemotron-3.5-lightning:free')
    expect(entry?.providerId).toBe('openrouter')
    // undefined = "assumed capable" (its supported_parameters DID list
    // tools/tool_choice on the live API 2026-08-14) — must NOT be false.
    expect(entry?.supportsToolCalling).not.toBe(false)
  })

  it('openrouter-auto-free is marked not-tool-capable (28/39 real tool-call failures)', () => {
    expect(catalogEntry('openrouter-auto-free')?.supportsToolCalling).toBe(false)
  })
})

describe('M27 B2 — behavior through the real chain resolution', () => {
  it('auto-free is dropped from a tool-using chain but kept for a text chain', () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      assignments('summary', ['openrouter-nemotron-3.5-lightning', 'openrouter-auto-free'])
    )

    const withTool = resolveChain('summary', { needsTool: true })
    // It's still CONFIGURED (the user/chain lists it) — just not CAPABLE for
    // a forced-tool request, the exact configured-vs-capable split resolveChain
    // exists to express.
    expect(withTool.configured.map((s) => s.catalogId)).toContain('openrouter-auto-free')
    expect(withTool.capable.map((s) => s.catalogId)).not.toContain('openrouter-auto-free')
    // The replacement Nemotron IS tool-capable, so it survives the same filter
    // — proving the filter is discriminating on the flag, not dropping every
    // openrouter entry.
    expect(withTool.capable.map((s) => s.catalogId)).toContain('openrouter-nemotron-3.5-lightning')

    const noTool = resolveChain('summary')
    expect(noTool.capable.map((s) => s.catalogId)).toContain('openrouter-auto-free')
  })

  it('every id in every DEFAULT_CATALOG_CHAIN resolves to a real catalog entry', () => {
    // Would NOT have caught the original nemotron bug (that id DID exist; the
    // model behind it was dead) — but it DOES catch exactly the mistake this
    // change risks introducing: renaming the catalog id without updating the
    // QUALITY_CHAIN reference that points at it. A cheap standing invariant.
    for (const [purpose, ids] of Object.entries(DEFAULT_CATALOG_CHAIN)) {
      for (const id of ids) {
        expect(
          catalogEntry(id),
          `${purpose} chain references unknown catalog id "${id}"`
        ).toBeDefined()
      }
    }
  })
})
