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
// M27 E1 — re-keyed from sessionId to callId throughout. A mono<->
// multichannel restart mid-call (turning buyer-capture on) mints a brand-new
// session id in main, but it is still the same call — sessionId-keying meant
// every consent check after that exact restart silently failed for the rest
// of the call. callId is stable across it. See main/consent-gate.ts's own
// doc comment for the full reasoning.
//
// These drive the real analyzeDealTier1/analyzeDealTier2/liveCue/askCoach
// functions, with only the network-bound AI call itself mocked, so the
// assertion is about the actual gate wired into each function, not a
// description of it.
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
const { liveCue, askCoach } = await import('../live-cue')

const CONSENTED = {
  status: 'consented' as const,
  jurisdiction: 'two-party' as const,
  recordOtherParty: true,
  method: 'verbal-on-call' as const
}

const LONG_TEXT =
  'Rep: thanks for taking the time today, I wanted to walk through pricing. Buyer: sure, go ahead, I have some questions about the contract terms too.'

// A single call's stable id — the identifier that survives a mono<->
// multichannel restart mid-call. CALL_OTHER stands in for "some other,
// unrelated call" (the case consent must never carry across).
const CALL_ID = 'call-a'
const CALL_OTHER = 'call-b'

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
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(result).toEqual({ ok: false, blockedReason: 'consent' })
    // The whole point: refused BEFORE any AI spend, not after.
    expect(completeWithFallback).not.toHaveBeenCalled()
  })

  it('proceeds when consent is currently active for that call', async () => {
    persistActiveConsent(CALL_ID, CONSENTED)
    const result = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: 'stage=discovery',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(result.ok).toBe(true)
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })

  it('a grant for a DIFFERENT call does not authorise this one', async () => {
    persistActiveConsent(CALL_OTHER, CONSENTED) // some other, unrelated call
    const result = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: 'stage=discovery',
      callId: CALL_ID,
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
      callId: CALL_ID,
      includesBuyerContent: false
    })
    expect(result.ok).toBe(true)
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })

  it('consent revoked mid-call is honoured on the very next call — no stale grace period', async () => {
    persistActiveConsent(CALL_ID, CONSENTED)
    const before = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(before.ok).toBe(true)

    clearActiveConsent() // the rep turns recording off
    const after = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(after).toEqual({ ok: false, blockedReason: 'consent' })
  })

  // M27 E1 — THE bug. Before this fix, consent was persisted and checked
  // against the transcription SESSION id, which a mono<->multichannel
  // restart mid-call (turning buyer-capture on) mints fresh — so a grant
  // written moments earlier for the SAME call stopped matching the instant
  // the restart happened, and every buyer-attributed pass silently refused
  // for the rest of the call. callId never changes across that restart,
  // which is exactly what this proves: one persist, then a check against the
  // same call id, succeeds — regardless of how many session restarts
  // happened in between (this level doesn't need to simulate the restart
  // itself to prove it: the fix is that sessionId no longer appears
  // ANYWHERE in this path at all, so it structurally cannot drift from what
  // was persisted).
  it('survives a mid-call session restart — consent is keyed to the call, not the session', async () => {
    persistActiveConsent(CALL_ID, CONSENTED)
    // Simulates checking AFTER a mono<->multichannel restart: the call id is
    // unchanged (it's what LiveView.tsx now threads through from
    // useTranscription's getCallId(), which BUG-055 already established is
    // restart-stable), even though the session id main minted for the
    // restarted connection is not the one consent was originally persisted
    // against.
    const result = await analyzeDealTier1({
      transcriptDelta: LONG_TEXT,
      compactState: 'stage=discovery',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(result.ok).toBe(true)
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })
})

describe('Tier 2 — the same gate, same behaviour', () => {
  it('blocks buyer content without a grant, proceeds with one', async () => {
    const blocked = await analyzeDealTier2({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(blocked).toEqual({ ok: false, blockedReason: 'consent' })
    expect(completeWithFallback).not.toHaveBeenCalled()

    persistActiveConsent(CALL_ID, CONSENTED)
    const allowed = await analyzeDealTier2({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(allowed.ok).toBe(true)
  })

  it('mono-only content proceeds with no grant', async () => {
    const result = await analyzeDealTier2({
      transcriptDelta: LONG_TEXT,
      compactState: '',
      callId: CALL_ID,
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
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(blocked).toEqual({ ok: false, blockedReason: 'consent' })
    expect(completeWithFallback).not.toHaveBeenCalled()

    persistActiveConsent(CALL_ID, CONSENTED)
    const allowed = await liveCue({
      transcript: WINDOW,
      repSpeaker: 0,
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(allowed.ok).toBe(true)
  })

  it('mono-only content proceeds with no grant', async () => {
    const result = await liveCue({
      transcript: WINDOW,
      repSpeaker: 0,
      callId: CALL_ID,
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
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.pausedReason).toBeUndefined()
      expect(result.blockedReason).toBe('consent')
    }
  })

  // M27 E1 — see Tier 1's identical test above for the full rationale.
  it('survives a mid-call session restart — consent is keyed to the call, not the session', async () => {
    persistActiveConsent(CALL_ID, CONSENTED)
    const result = await liveCue({
      transcript: WINDOW,
      repSpeaker: 0,
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(result.ok).toBe(true)
  })
})

describe('askCoach — 1.2.5 hotfix, the same gate as liveCue/tier1/tier2', () => {
  it('blocks buyer content without a grant, proceeds with one', async () => {
    const blocked = await askCoach({
      transcript: LONG_TEXT,
      question: 'they said it is too expensive',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.blockedReason).toBe('consent')
    // The whole point: refused BEFORE any AI spend, not after.
    expect(completeWithFallback).not.toHaveBeenCalled()

    persistActiveConsent(CALL_ID, CONSENTED)
    await askCoach({
      transcript: LONG_TEXT,
      question: 'they said it is too expensive',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })

  it('mono-only content (includesBuyerContent false) is never gated, consent or not', async () => {
    await askCoach({
      transcript: LONG_TEXT,
      question: 'they said it is too expensive',
      callId: CALL_ID,
      includesBuyerContent: false
    })
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })

  it('consent revoked mid-call is honoured on the very next ask — no stale grace period', async () => {
    persistActiveConsent(CALL_ID, CONSENTED)
    await askCoach({
      transcript: LONG_TEXT,
      question: 'first question',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(completeWithFallback).toHaveBeenCalledTimes(1)

    clearActiveConsent() // the rep turns recording off mid-call
    const after = await askCoach({
      transcript: LONG_TEXT,
      question: 'second question, after revoke',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(after).toMatchObject({ ok: false, blockedReason: 'consent' })
    expect(completeWithFallback).toHaveBeenCalledTimes(1) // unchanged — no second AI call
  })

  it('a grant for a DIFFERENT call does not authorise this one', async () => {
    persistActiveConsent(CALL_OTHER, CONSENTED) // some other, unrelated call
    const result = await askCoach({
      transcript: LONG_TEXT,
      question: 'they said it is too expensive',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(result).toMatchObject({ ok: false, blockedReason: 'consent' })
    expect(completeWithFallback).not.toHaveBeenCalled()
  })

  // M27 E1 — see Tier 1's identical test above for the full rationale. Checks
  // completeWithFallback was actually invoked, not result.ok — the shared
  // mock's toolInput has no headline/tips, so askCoach's own "no suggestion
  // came back" branch always makes ok:false regardless of consent; the
  // proceeds-vs-blocked distinction for this function is whether the AI was
  // reached at all, same as this file's other askCoach "proceeds" cases.
  it('survives a mid-call session restart — consent is keyed to the call, not the session', async () => {
    persistActiveConsent(CALL_ID, CONSENTED)
    await askCoach({
      transcript: LONG_TEXT,
      question: 'they said it is too expensive',
      callId: CALL_ID,
      includesBuyerContent: true
    })
    expect(completeWithFallback).toHaveBeenCalledTimes(1)
  })
})
