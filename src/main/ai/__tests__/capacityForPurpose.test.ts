// BUG-071 — hasUsableCapacityForPurpose against the REAL cooldown machinery.
//
// Written because the claim audit for 1.3.0 found a hole: every test proving
// the purpose-aware deferral works injects a FAKE gate into JobManager. Those
// tests prove the scheduler consumes the answer correctly; not one of them
// proves the function producing that answer is right about real cooldown
// state. The scheduler was verified and the thing it depends on was not.
//
// The money assertion is the third one. It shows the two capacity questions
// genuinely DIVERGE on real state — not merely on a mock built to make them
// diverge — which is the entire bug: a purpose's chain fully exhausted while
// the whole-catalog question still answers "yes, there's capacity".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

const { hasUsableAiCapacity, hasUsableCapacityForPurpose } = await import('../capacity')
const { configuredStepsFor } = await import('../complete-with-fallback')
const { MODEL_CATALOG } = await import('../model-catalog')
const { markPeriodExhausted, markStructurallyBroken, resetCooldownsForTests } = await import(
  '../model-cooldown'
)
const { resetPacingForTests } = await import('../model-pacing')
const { PROVIDER_REGISTRY } = await import('../registry')

const ORIGINAL_ENV = { ...process.env }
const NOW = 1_000_000
const PURPOSE = 'memory-extract' as const

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'callrise-capacity-purpose-'))
  resetCooldownsForTests()
  resetPacingForTests()
  process.env = { ...ORIGINAL_ENV }
  for (const p of Object.values(PROVIDER_REGISTRY)) delete process.env[p.keyEnvName]
  // EVERY provider keyed, deliberately. The bug only appears when models
  // exist outside the failing purpose's chain — a single-provider setup
  // cannot express it.
  for (const p of Object.values(PROVIDER_REGISTRY)) process.env[p.keyEnvName] = 'test-key'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  rmSync(dir, { recursive: true, force: true })
})

/** The catalog ids this purpose will actually attempt, from the same
 *  resolution the real fallback walk uses — not a hand-listed guess. */
function chainIds(): string[] {
  // BUG-159 — the CONFIGURED set, which is what hasUsableCapacityForPurpose now
  // judges, not the walk's chain.
  //
  // These used to be the same list. Capacity read the walk's resolved chain,
  // which coupled the "does this user have capacity" question to "what would
  // this particular walk attempt" — and that coupling inverted the signal
  // whenever anything shortened the chain (see docs/BUG-159-api-team-design.md;
  // it cost three reverted attempts). Capacity now asks the configured set
  // directly, so a test that cools "everything" has to cool that same set:
  // cooling only what one walk reaches leaves the models beyond it usable, and
  // capacity would be RIGHT to say so.
  return configuredStepsFor(PURPOSE)
    .filter((s) => MODEL_CATALOG.find((e) => e.id === s.catalogId)?.supportsToolCalling !== false)
    .map((s) => s.catalogId)
}

describe('hasUsableCapacityForPurpose, against real cooldown state', () => {
  it('is true when nothing is cooling', () => {
    expect(hasUsableCapacityForPurpose(PURPOSE, NOW)).toBe(true)
  })

  it('stays true while any one entry in its own chain survives', () => {
    const ids = chainIds()
    expect(ids.length).toBeGreaterThan(1) // otherwise "any one survives" proves nothing
    for (const id of ids.slice(0, -1)) markPeriodExhausted(id, undefined, NOW, 'durable')
    expect(hasUsableCapacityForPurpose(PURPOSE, NOW)).toBe(true)
  })

  // THE ONE THAT MATTERS. Exhaust exactly this purpose's chain and nothing
  // else, then ask both questions. They must disagree — that disagreement is
  // the bug, and it is what the old gate could not see.
  it('goes false for an exhausted chain while the whole-catalog question still says yes', () => {
    const ids = chainIds()
    for (const id of ids) markPeriodExhausted(id, undefined, NOW, 'durable')

    expect(hasUsableCapacityForPurpose(PURPOSE, NOW)).toBe(false)

    // Every OTHER keyed model is untouched, so the old signal is still
    // cheerfully reporting capacity. This is the exact state the founder hit:
    // the app said "every model set up for THIS is rate-limited" while the
    // gate meant to prevent that said go.
    expect(hasUsableAiCapacity(NOW)).toBe(true)
  })

  it('counts a structural break as unusable too, not only a quota cooldown', () => {
    const ids = chainIds()
    for (const id of ids) markStructurallyBroken(id, NOW, PURPOSE)
    expect(hasUsableCapacityForPurpose(PURPOSE, NOW)).toBe(false)
  })

  // AUDIT FIX (2026-08-24) — breaks are purpose-scoped, so one purpose's
  // rejected request must not defer another purpose's work. Before the fix
  // this returned false and background jobs waited behind a "waiting for
  // provider capacity" label they could never clear.
  it("another purpose's structural break does not consume this purpose's capacity", () => {
    const ids = chainIds()
    for (const id of ids) markStructurallyBroken(id, NOW, 'assistant-chat')
    expect(hasUsableCapacityForPurpose(PURPOSE, NOW)).toBe(true)
  })

  it('recovers once the cooldown window passes', () => {
    const ids = chainIds()
    for (const id of ids) markPeriodExhausted(id, undefined, NOW, 'durable')
    expect(hasUsableCapacityForPurpose(PURPOSE, NOW)).toBe(false)
    // Past the 1h period-exhausted default. A gate that could never recover
    // would hold background work forever, which is worse than the bug.
    expect(hasUsableCapacityForPurpose(PURPOSE, NOW + 2 * 60 * 60_000)).toBe(true)
  })

  it('returns TRUE when no key is configured at all — a setup state, not pressure', () => {
    for (const p of Object.values(PROVIDER_REGISTRY)) delete process.env[p.keyEnvName]
    // Deferring here would hide the real, actionable "add an API key" error
    // behind a "waiting for provider capacity" label implying a temporary
    // condition. The job must run and fail visibly instead.
    expect(hasUsableCapacityForPurpose(PURPOSE, NOW)).toBe(true)
  })
})
