// BUG-149 — the chain stored behind a primary pick must be able to cross providers.
//
// `settings:assignPrimaryModel` derived the fallback from
// `DEFAULT_CATALOG_CHAIN[purpose]`, which for the two live purposes is already
// truncated by an ATTEMPTS cap (`SPEED_CHAIN.slice(0, 2)`) whose two survivors
// are BOTH Groq. So a user holding Groq and Cerebras keys still got a
// single-provider chain — on `coaching-cue`, the one path whose entire budget
// is a single attempt.
//
// These tests assert ORDER, not membership, for the same reason BUG-148's do:
// the stored chain is truncated to two on every load, so what matters is which
// two come FIRST. A `toContain` here would pass on the broken behaviour.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const saved: { chain?: string[] } = {}

vi.mock('electron', () => ({
  ipcMain: { handle: (_c: string, fn: unknown) => handlers.push(fn as Handler) }
}))
vi.mock('../../app-settings', () => ({
  loadAppSettings: () => ({}),
  saveAppSettings: (patch: { aiModelAssignments: Record<string, { chain: string[] }> }) => {
    saved.chain = Object.values(patch.aiModelAssignments)[0].chain
    return {}
  }
}))
vi.mock('../model-catalog', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, resolveCatalog: vi.fn() }
})

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers: Handler[] = []

const { registerModelCatalog } = await import('../catalog-ipc')
const { CANDIDATE_POOL } = await import('../complete-with-fallback')

const ORIGINAL_ENV = { ...process.env }

/** The registered `settings:assignPrimaryModel` handler. Located by CALLING
 *  each one and keeping whichever wrote a chain — the registration order is an
 *  implementation detail and indexing into it would break on any reorder. */
function assign(purpose: string, catalogId: string): string[] | undefined {
  saved.chain = undefined
  for (const h of handlers) {
    try {
      h(null, purpose, catalogId)
    } catch {
      /* other handlers reject these args; that is fine */
    }
    if (saved.chain) return saved.chain
  }
  return saved.chain
}

beforeEach(() => {
  handlers.length = 0
  registerModelCatalog()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

/** The fixture only means anything if the pool really is Groq-heavy at the
 *  front — the whole bug is that the first two entries share a provider. */
describe('the fixture assumption this bug rests on', () => {
  it("coaching-cue's first two candidates are both Groq", () => {
    expect(CANDIDATE_POOL['coaching-cue'].slice(0, 2).every((id) => id.startsWith('groq-'))).toBe(
      true
    )
  })

  it('...and a non-Groq speed model exists further down, outside the old cap', () => {
    expect(CANDIDATE_POOL['coaching-cue'].slice(2).some((id) => id.startsWith('cerebras-'))).toBe(
      true
    )
  })
})

describe('BUG-149: a second provider takes the slot behind the pick', () => {
  it('THE FIELD CASE: Groq + Cerebras keys produce a CROSS-PROVIDER live chain', () => {
    process.env.GROQ_API_KEY = 'g'
    process.env.CEREBRAS_API_KEY = 'c'

    const chain = assign('coaching-cue', 'groq-llama-3.1-8b-instant')

    expect(chain?.[0]).toBe('groq-llama-3.1-8b-instant')
    // Position 1 is the only other slot that survives the load-time cap of 2.
    // Before this fix it was groq-llama-3.3-70b-versatile.
    expect(chain?.[1]).toMatch(/^cerebras-/)
  })

  it('a Groq-ONLY user keeps a Groq fallback rather than an unusable one', () => {
    // The regression this fix must not cause. Ordering by provider diversity
    // ALONE would put Cerebras second for someone with no Cerebras key, and the
    // runtime would filter it out — leaving a one-step chain where they used to
    // have two. Keyed-first, then diversity WITHIN keyed, keeps both properties.
    process.env.GROQ_API_KEY = 'g'
    delete process.env.CEREBRAS_API_KEY

    const chain = assign('coaching-cue', 'groq-llama-3.1-8b-instant')

    expect(chain?.[0]).toBe('groq-llama-3.1-8b-instant')
    expect(chain?.[1]).toMatch(/^groq-/)
  })

  it('picking the non-Groq model still puts a Groq fallback behind it', () => {
    process.env.GROQ_API_KEY = 'g'
    process.env.CEREBRAS_API_KEY = 'c'

    const chain = assign('coaching-cue', 'cerebras-gpt-oss-120b')

    expect(chain?.[0]).toBe('cerebras-gpt-oss-120b')
    expect(chain?.[1]).toMatch(/^groq-/)
  })

  it('unkeyed candidates are kept, but sort last so they never take a capped slot', () => {
    process.env.GROQ_API_KEY = 'g'
    delete process.env.CEREBRAS_API_KEY

    const chain = assign('coaching-cue', 'groq-llama-3.1-8b-instant')

    // Still present — dropping them would lose the user's chain the moment they
    // added the key. Just never in front of something usable.
    expect(chain).toContain('cerebras-gpt-oss-120b')
    expect(chain?.indexOf('cerebras-gpt-oss-120b')).toBeGreaterThan(1)
  })
})
