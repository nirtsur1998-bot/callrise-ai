// M26 4.5 (BUG-055) — buyer-attributed content must never reach an AI prompt
// without a CURRENTLY active, freshly-checked consent grant.
//
// Item 2 from the founder's review: hoisting the cue/deal-intelligence
// engines above the navigation boundary removes the ACCIDENTAL protection
// that used to cap how long stale analysis could keep running (the engine's
// whole instance died on nav-away). This gate is the DELIBERATE replacement,
// and per the founder's own ordering requirement, it had to land in the SAME
// commit as the hoist — not a follow-up.
//
// These drive the real analyzeDealTier1/analyzeDealTier2/liveCue functions,
// with only the network-bound AI call itself mocked, so the assertion is
// about the actual gate wired into each function, not a description of it.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const completeWithFallback = vi.fn(async () => ({
  toolInput: {
    signals: [],
    score: 50,
    factors: { engagement: 50, sentiment: 50, objectionStatus: 50, momentum: 50, agendaCoverage: 50 },
    topRecommendation: 'stub',
    repSpeaker: 0,
    cue: 'none',
    text: ''
  }
}))
vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback,
  AllModelsExhaustedError: class extends Error {}
}))
vi.mock('../app-settings', () => ({
  isSelfIntroExtractionAllowed: () => false,
  isSalesBrainEnabled: () => false
}))

const { setConsentGateDirForTests, persistActiveConsent, clearActiveConsent } =
  await import('../consent-gate')
const { analyzeDealTier1 } = await import('../deal-tier1')
const { analyzeDealTier2 } = await import('../deal-tier2')
const { liveCue } = await import('../live-cue')

const CONSENTED = {
  status: 'consented' as const,
  jurisdiction: 'two-party' as const,
  recordOtherParty: true,
  method: 'verbal-on-call' as const
}

const LONG_TEXT =
  'Rep: thanks for taking the time today, I wanted to walk through pricing. Buyer: sure, go ahead, I have some questions about the contract terms too.'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'consent-gate-'))
  setConsentGateDirForTests(dir)
  completeWithFallback.mockClear()
})

afterEach(() => {
  clearActiveConsent()
  setConsentGateDirForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('Tier 1 refuses buyer content without a current consent grant', () => {
  it('blocks when includesBuyerContent is true and no grant exists', async () => {
    const result = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: 'stage=discovery',
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(result).toEqual({ ok: false, blockedReason: 'consent' })
    // The whole point: refused BEFORE any AI spend, not after.
    expect(completeWithFallback).not.toHaveBeenCalled()
  })

  it('proceeds when consent is currently active for that session', async () => {
    persistActiveConsent(1, CONSENTED)
    const result = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: 'stage=discovery',
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(result.ok).toBe(true)
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })

  it('a grant for a DIFFERENT session does not authorise this one', async () => {
    persistActiveConsent(2, CONSENTED) // some other, unrelated call
    const result = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: 'stage=discovery',
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(result).toEqual({ ok: false, blockedReason: 'consent' })
  })

  it('mono-only content (includesBuyerContent false) is never gated, consent or not', async () => {
    // No consent grant at all — and it must not matter, since there is no
    // buyer content in scope. Gating this would break coaching on the
    // majority of ordinary mic-only calls, which never had a consent
    // question to begin with (BUG-002's own reasoning, restated for AI calls).
    const result = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: 'stage=discovery',
      sessionId: 1,
      includesBuyerContent: false
    })
    expect(result.ok).toBe(true)
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })

  it('consent revoked mid-call is honoured on the very next call — no stale grace period', async () => {
    persistActiveConsent(1, CONSENTED)
    const before = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(before.ok).toBe(true)

    clearActiveConsent() // the rep turns recording off
    const after = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(after).toEqual({ ok: false, blockedReason: 'consent' })
  })
})

describe('Tier 2 — the same gate, same behaviour', () => {
  it('blocks buyer content without a grant, proceeds with one', async () => {
    const blocked = await analyzeDealTier2({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(blocked).toEqual({ ok: false, blockedReason: 'consent' })
    expect(completeWithFallback).not.toHaveBeenCalled()

    persistActiveConsent(1, CONSENTED)
    const allowed = await analyzeDealTier2({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(allowed.ok).toBe(true)
  })

  it('mono-only content proceeds with no grant', async () => {
    const result = await analyzeDealTier2({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      sessionId: 1,
      includesBuyerContent: false
    })
    expect(result.ok).toBe(true)
  })
})

describe('liveCue — the same gate, same behaviour', () => {
  const WINDOW = 'Speaker 0: thanks for joining today\nSpeaker 1: happy to be here, tell me about pricing'

  it('blocks buyer content without a grant, proceeds with one', async () => {
    const blocked = await liveCue({
      transcript: WINDOW,
      repSpeaker: 0,
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(blocked).toEqual({ ok: false, blockedReason: 'consent' })
    expect(completeWithFallback).not.toHaveBeenCalled()

    persistActiveConsent(1, CONSENTED)
    const allowed = await liveCue({
      transcript: WINDOW,
      repSpeaker: 0,
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(allowed.ok).toBe(true)
  })

  it('mono-only content proceeds with no grant', async () => {
    const result = await liveCue({
      transcript: WINDOW,
      repSpeaker: 0,
      sessionId: 1,
      includesBuyerContent: false
    })
    expect(result.ok).toBe(true)
  })

  it('a consent-blocked refusal is never mistaken for "AI unavailable" by the renderer’s own check', async () => {
    // The renderer's actual gate is `pausedReason === 'all-models-unavailable'`
    // (useLiveCues.ts / useDealIntelligence.ts) — this pins the contract from
    // the main side: a consent block must never set pausedReason.
    const result = await liveCue({
      transcript: WINDOW,
      repSpeaker: 0,
      sessionId: 1,
      includesBuyerContent: true
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.pausedReason).toBeUndefined()
      expect(result.blockedReason).toBe('consent')
    }
  })
})
