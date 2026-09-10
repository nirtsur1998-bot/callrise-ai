// M39 — the live cue must not hand the app a name that isn't one.
//
// THE GAP THIS CLOSES, stated as the sequence it produced. The model answers
// `buyerName: "someone"` — measured habit, not imagination: the founder's
// profile carries 7 persisted `{ name: 'someone', source: 'self-intro' }`
// records. `modelStringOrNull` passes it (its absence list is BUG-163's, and
// "someone" is a perfectly good string). It becomes `buyerName` in
// useLiveCues, which is a ONE-SHOT per call — so for the rest of the
// conversation the live transcript labels the other party's every turn
// "someone", the save-time identity ref holds it, and (from this milestone)
// the live identity chip offers to create a contact for it.
//
// calls-fs refuses to PERSIST it. That refusal is at the end of the pipeline
// and this value is on screen from the first minute, so guarding only the
// write left the entire visible half intact. The guard now runs where the
// name enters the app.
//
// Drives the REAL liveCue with only the model call mocked — the claim under
// test is our own validation, not the provider's behaviour. Every case is
// PAIRED with a real name through the identical path, because a guard that
// rejects everything and a guard that works look the same from one side.
import { describe, expect, it, beforeEach, vi } from 'vitest'

const completeWithFallback = vi.fn()
vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback,
  AllModelsExhaustedError: class extends Error {}
}))
// The self-intro opt-in is the gate this rides behind; on, so the code under
// test is reachable at all. (Its own negative control is below.)
//
// PARTIAL, deliberately. The first version of this mock listed the three
// exports live-cue.ts appeared to use and the suite died on a fourth
// (`isSalesBrainEnabled`, reached indirectly through profile-injection) — the
// "mocks missing a surface" failure, caught here only because it happened to
// throw rather than route the code quietly down another branch.
const isSelfIntroExtractionAllowed = vi.fn(() => true)
vi.mock('../app-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../app-settings')>()),
  isSelfIntroExtractionAllowed: () => isSelfIntroExtractionAllowed()
}))
vi.mock('../consent-gate', () => ({ consentPermitsCapture: () => true }))
vi.mock('../knowledge-fs', () => ({ listEntries: async () => [] }))
vi.mock('../knowledge-context', () => ({ assembleKnowledgeContext: () => '' }))
vi.mock('../custom-trackers', () => ({
  listCustomTrackers: () => [],
  saveCustomTrackers: () => {}
}))
vi.mock('electron', () => ({
  app: { getPath: () => 'C:/nowhere' },
  ipcMain: { handle: () => {} }
}))

const { liveCue } = await import('../live-cue')

/** A transcript long enough to pass the 30-char floor, with two real speakers
 *  so the buyer-speaker guard (must be observed, must not be the rep) holds. */
const TRANSCRIPT = [
  'Speaker 0: Thanks very much for making the time today, appreciate it.',
  'Speaker 1: Of course, good to meet you, happy to be here.'
].join('\n')

// `toolInput`, which is what live-cue.ts actually reads. The first version of
// this helper returned `{ toolCall: { input } }` — a plausible shape from a
// different SDK — so `raw` was undefined, every field defaulted, and all
// eleven refusal cases passed against a guard that was never reached. The
// paired control is the only reason that is a paragraph here and not a
// shipped claim.
function modelSays(buyerName: unknown): void {
  completeWithFallback.mockResolvedValue({
    toolInput: {
      repSpeaker: 0,
      cue: 'none',
      text: '',
      buyerName,
      buyerSpeaker: 1
    }
  })
}

const ask = (): ReturnType<typeof liveCue> =>
  liveCue({ transcript: TRANSCRIPT, repSpeaker: 0, includesBuyerContent: false })

beforeEach(() => {
  completeWithFallback.mockReset()
  isSelfIntroExtractionAllowed.mockReturnValue(true)
})

describe('M39 — a live buyerName that is not a name is refused at the boundary', () => {
  it('the CONTROL: a real name still arrives, through the identical path', async () => {
    modelSays('Sarah Chen')
    const res = await ask()
    expect(res.ok).toBe(true)
    expect(res.ok && res.buyerName).toBe('Sarah Chen')
    expect(res.ok && res.buyerSpeaker).toBe(1)
  })

  it.each([
    ['someone', 'the exact string on 7 of the founder\u2019s calls'],
    ['the client', 'a category, not a person'],
    ['The Client', 'same, capitalised'],
    ['Speaker 2', 'a diarization label read back as a name'],
    ['speaker 1', 'lower case'],
    ['unknown', 'the model saying it could not tell'],
    ['N/A', 'the same, in form-speak'],
    ['null', "BUG-163's original, still caught"],
    ['the other party', 'our own vocabulary handed back to us'],
    ['the prospect', 'the sales word for it'],
    ['a customer', 'with an article']
  ])('refuses %j (%s)', async (name) => {
    modelSays(name)
    const res = await ask()
    // ok:true — the CUE half of this response is unaffected. Only the name is
    // dropped. A guard that failed the whole request would take the rep's
    // coaching away over a naming problem.
    expect(res.ok).toBe(true)
    expect(res.ok && res.buyerName).toBeNull()
    expect(res.ok && res.buyerSpeaker).toBeNull()
  })

  it.each([
    ['Guy Fisher', 'Guy is a real first name — never eat one'],
    ['Frank', 'so is Frank, and "frankly" is not this'],
    ['Nunes', 'contains "nu"… and "null" was BUG-163'],
    ['Summer Nolan', 'contains "someone"? no — but starts the same way'],
    ['Person Chen', 'an unusual name is still a name']
  ])('keeps %j (%s)', async (name) => {
    modelSays(name)
    const res = await ask()
    expect(res.ok && res.buyerName).toBe(name)
  })

  it('the opt-in still governs: extraction off means no name at all', async () => {
    // The negative control for the gate this guard sits behind. Without it,
    // a passing suite would be equally consistent with the guard never being
    // reached because the feature is off.
    isSelfIntroExtractionAllowed.mockReturnValue(false)
    modelSays('Sarah Chen')
    const res = await ask()
    expect(res.ok && res.buyerName).toBeNull()
  })
})
