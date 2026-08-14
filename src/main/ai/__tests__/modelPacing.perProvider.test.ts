// M27 H2 — per-provider pacing gaps. PACING_GAP_MS shipped (BUG-058) as one
// global 6s constant, over-conservative for the free tiers that document a
// higher per-request rate than Gemini's 10 RPM. These drive the REAL
// isPacedFor against REAL catalog ids (no fixtures) so the assertion is about
// the actual provider→gap wiring, not a described mapping.
//
// Gaps under test (60_000 / documented free-tier RPM):
//   groq       ~30 RPM → 2_000ms
//   openrouter ~20 RPM → 3_000ms
//   google (Gemini) and everything else → the 6_000ms default (10 RPM).
import { beforeEach, describe, expect, it } from 'vitest'
import { isPacedFor, markUsed, resetPacingForTests, PACING_GAP_MS } from '../model-pacing'

// Real catalog ids, one per provider whose gap we care about.
const GROQ = 'groq-gpt-oss-120b'
const OPENROUTER = 'openrouter-auto-free'
const GOOGLE = 'google-gemini-flash'
const NVIDIA = 'nvidia-deepseek-v3.2' // no per-provider entry → default

beforeEach(() => {
  resetPacingForTests()
})

describe('M27 H2 — the gap is keyed on the model\'s provider', () => {
  it('a Groq model clears its shorter 2s gap where a Google model would still be paced', () => {
    markUsed(GROQ, 1_000, 'durable')
    markUsed(GOOGLE, 1_000, 'durable')

    // At +2_500ms: past Groq's 2s gap (usable again), still inside Google's 6s.
    expect(isPacedFor(GROQ, 1_000 + 2_500, 'durable')).toBe(false)
    expect(isPacedFor(GOOGLE, 1_000 + 2_500, 'durable')).toBe(true)
  })

  it('a Groq model is still paced INSIDE its 2s gap — the shorter gap is real, not "no gap"', () => {
    markUsed(GROQ, 1_000, 'durable')
    expect(isPacedFor(GROQ, 1_000 + 1_900, 'durable')).toBe(true)
    expect(isPacedFor(GROQ, 1_000 + 2_000, 'durable')).toBe(false)
  })

  it('an OpenRouter model uses a 3s gap — between Groq and the default', () => {
    markUsed(OPENROUTER, 1_000, 'durable')
    expect(isPacedFor(OPENROUTER, 1_000 + 2_900, 'durable')).toBe(true)
    expect(isPacedFor(OPENROUTER, 1_000 + 3_000, 'durable')).toBe(false)
  })

  it('a provider with no documented rate falls to the conservative 6s default', () => {
    markUsed(NVIDIA, 1_000, 'durable')
    expect(isPacedFor(NVIDIA, 1_000 + PACING_GAP_MS - 1, 'durable')).toBe(true)
    expect(isPacedFor(NVIDIA, 1_000 + PACING_GAP_MS, 'durable')).toBe(false)
    // Concretely shorter-gap providers are NOT usable at the same point NVIDIA
    // still-paced would be — i.e. NVIDIA really is on the long default, not a
    // short gap by accident.
    expect(isPacedFor(NVIDIA, 1_000 + 2_500, 'durable')).toBe(true)
  })

  it('a legacy:<provider> step (no catalog entry) still gets its provider\'s gap', () => {
    // legacyStep()'s synthetic id carries the provider in the string itself.
    markUsed('legacy:groq', 1_000, 'durable')
    expect(isPacedFor('legacy:groq', 1_000 + 2_500, 'durable')).toBe(false) // Groq's 2s gap
    markUsed('legacy:google', 1_000, 'durable')
    expect(isPacedFor('legacy:google', 1_000 + 2_500, 'durable')).toBe(true) // default 6s gap
  })
})
