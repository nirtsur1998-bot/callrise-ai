// M22 bug hunt: resolveChain skipped a configured entry when its provider had
// no key, but not when the catalog itself already knows the entry is dead
// (model-catalog.ts's `knownStale` — set when a model 404'd off its
// provider's live list, e.g. groq-llama-4-scout / groq-qwen3-32b, both
// confirmed delisted 2026-07-30). A user who assigned one of these as primary
// got a guaranteed failure on every attempt, silently wasting one of a
// possibly short chain's few slots (coaching-cue is capped at 2, "so a miss
// never means dead air") on a model that can never succeed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../app-settings', () => ({ loadAppSettings: vi.fn() }))
vi.mock('../fallback-log', () => ({ logFallbackEvent: vi.fn() }))
vi.mock('../index', () => ({ getActiveAIProvider: () => null }))

const { loadAppSettings } = await import('../../app-settings')
const { resolveChain } = await import('../complete-with-fallback')

function assignments(purpose: string, chain: string[]): ReturnType<typeof loadAppSettings> {
  return {
    aiModelAssignments: {
      'coaching-cue': { chain: [] },
      summary: { chain: [] },
      scorecard: { chain: [] },
      tasks: { chain: [] },
      other: { chain: [] },
      'prep-brief': { chain: [] },
      [purpose]: { chain }
    }
  } as unknown as ReturnType<typeof loadAppSettings>
}

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env.GROQ_API_KEY = 'test-key'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  vi.mocked(loadAppSettings).mockReset()
})

describe('resolveChain — known-stale catalog entries', () => {
  it('skips a knownStale entry even though its provider has a key configured', () => {
    vi.mocked(loadAppSettings).mockReturnValue(
      assignments('summary', ['groq-llama-4-scout', 'groq-gpt-oss-120b'])
    )
    const steps = resolveChain('summary')
    expect(steps.map((s) => s.catalogId)).not.toContain('groq-llama-4-scout')
  })

  it('skips a knownStale entry even with the key present — the key was never the reason it fails', () => {
    // Distinguishes this from the pre-existing "no key configured" skip:
    // GROQ_API_KEY is set (see beforeEach), so if this entry's still being
    // resolved, that's a real bug, not this test's own setup. A single-entry
    // stale-only configured chain falls through to the bundled default
    // chain (existing, unrelated behavior — "configured chain resolves to
    // nothing" already falls back rather than guaranteeing failure), so the
    // assertion is narrowly "never resolves the stale entry itself", not
    // "resolves nothing at all".
    vi.mocked(loadAppSettings).mockReturnValue(assignments('summary', ['groq-qwen3-32b']))
    const steps = resolveChain('summary')
    expect(steps.map((s) => s.catalogId)).not.toContain('groq-qwen3-32b')
  })

  it('still resolves a normal, non-stale entry with a key configured', () => {
    vi.mocked(loadAppSettings).mockReturnValue(assignments('summary', ['groq-gpt-oss-120b']))
    const steps = resolveChain('summary')
    expect(steps.map((s) => s.catalogId)).toEqual(['groq-gpt-oss-120b'])
  })
})
