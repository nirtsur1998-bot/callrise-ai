// BUG-108 — WIRING test for the total prompt bound.
//
// prompt-budget.test.ts proves the policy is correct in isolation. That is
// worth nothing on its own: a correct module nothing calls does not bound
// anything. This drives the REAL 'coachChat:send' handler end to end, with
// only the I/O boundary mocked (electron, the file stores, the provider), and
// asserts on what streamWithFallback was actually handed.
//
// The fixture is built from the REAL shipped caps — a >100,000-char
// transcript, 20 user turns at the 8,000 entry cap and 20 assistant turns at
// MAX_CHAT_TEXT 16,000 — not 8,000 across the board, which would pass against
// a bound a real session can still blow.
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { budgetCharsFor, DEFAULT_CONTEXT_WINDOW_TOKENS } from '../assistant/prompt-budget'

const BUDGET = budgetCharsFor(DEFAULT_CONTEXT_WINDOW_TOKENS)

const OPENING = 'OPENING-LINE-MARKER-should-not-survive'
const CLOSING = 'CLOSING-LINE-MARKER-must-survive'

interface StreamArgs {
  system: string
  messages: { role: 'user' | 'assistant'; content: string }[]
}
let lastStreamArgs: StreamArgs | null = null

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/tmp/callrise-test' },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))

// A >100,000-char transcript with identifiable ends, so the test can tell
// WHICH end survived. A length-only assertion would pass with either
// truncation direction and prove nothing about the founder's decision.
function bigSegments(): { speaker: number; text: string }[] {
  const segs = [{ speaker: 0, text: OPENING }]
  for (let i = 0; i < 200; i++) segs.push({ speaker: i % 2, text: `filler-${i}-`.padEnd(700, 'f') })
  segs.push({ speaker: 1, text: CLOSING })
  return segs
}

// History as actually persisted: user/assistant PAIRS, user bounded by the
// 8,000 entry cap, assistant by MAX_CHAT_TEXT 16,000.
function bigHistory(): { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; mode: 'advisor' }[] {
  return Array.from({ length: 40 }, (_, i) => ({
    id: `m${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: i % 2 === 0 ? `u${i}-`.padEnd(8_000, 'u') : `a${i}-`.padEnd(16_000, 'a'),
    createdAt: '2026-08-01T00:00:00.000Z',
    mode: 'advisor' as const
  }))
}

const testCall = {
  id: 'call-1',
  title: 'Acme discovery',
  createdAt: '2026-08-01T00:00:00.000Z',
  segments: bigSegments(),
  coachChat: bigHistory(),
  notes: 'N'.repeat(20_000), // MAX_NOTES_CHARS — part of the fixed floor
  contactId: undefined
}

vi.mock('../calls-fs', () => ({
  getCall: vi.fn(async () => testCall),
  listCalls: vi.fn(async () => []),
  // Mirrors the real return shape (BUG-110): the ids it MINTED, so the
  // caller never infers which stored message was which by position.
  appendCoachChatTurn: vi.fn(async () => ({
    call: testCall,
    userMessageId: 'minted-user-id',
    assistantMessageId: 'minted-assistant-id'
  })),
  appendCallNotes: vi.fn(async () => testCall),
  appendCommitment: vi.fn(async () => testCall),
  // Real behaviour: drop kind:'gap' silence markers, keep real speech.
  speechSegments: (segs: { kind?: string }[]) => segs.filter((s) => s.kind !== 'gap'),
  SKILL_KEYS: ['discovery', 'rapport']
}))
vi.mock('../contacts-fs', () => ({ getContact: vi.fn(async () => null), addComment: vi.fn() }))
vi.mock('../tasks-fs', () => ({ createTask: vi.fn() }))
vi.mock('../post-call-brief', () => ({ generatePostCallBrief: vi.fn() }))
vi.mock('../crm-notes', () => ({ generateCrmNote: vi.fn() }))
vi.mock('../kyc-apply', () => ({ applyKycField: vi.fn() }))
vi.mock('../prep-brief-fs', () => ({ formatContactContext: () => '' }))
vi.mock('../backup', () => ({ scheduleBackup: vi.fn() }))
vi.mock('../app-settings', () => ({ isSalesBrainEnabled: () => false }))
const runMemoryExtractionForChatMessage = vi.fn(async () => undefined)
vi.mock('../memory/memory-hooks', () => ({ runMemoryExtractionForChatMessage }))
// Mutable so one test can grow the FIXED floor — the part of the system
// prompt the budget may not cut. Sales Brain 'full' profiles are injected
// with no cap of their own, so this is the realistic lever that forces the
// budget past dropping history and into trimming the transcript itself.
let salesBrainProfile = ''
vi.mock('../memory/profile-injection', () => ({
  repProfileSection: () => salesBrainProfile,
  businessProfileSection: () => '',
  clientProfileSection: () => ''
}))
vi.mock('../memory/rag', () => ({ retrieveRelevantMemories: vi.fn(async () => '') }))
vi.mock('../memory/consolidation', () => ({ consolidateNewCandidate: vi.fn() }))
vi.mock('../memory/memory-runtime', () => ({ getMemoryDb: () => null }))
vi.mock('../ai', () => ({ AIProviderError: class extends Error {} }))
vi.mock('../ai/complete-with-fallback', () => ({
  completeWithFallback: vi.fn(async () => ({ toolInput: { suggestions: [] } })),
  streamWithFallback: vi.fn((args: StreamArgs) => {
    lastStreamArgs = { system: args.system, messages: args.messages }
    return {
      async *[Symbol.asyncIterator]() {
        yield { delta: 'ok' }
      },
      final: Promise.resolve({})
    }
  }),
  AllModelsExhaustedError: class extends Error {}
}))

const { registerCoachingChat } = await import('../coaching-chat-ipc')
registerCoachingChat()

const promptChars = (a: StreamArgs): number =>
  a.system.length + a.messages.reduce((n, m) => n + m.content.length, 0)

async function send(message: string): Promise<void> {
  const handler = handlers.get('coachChat:send')
  expect(handler, "the 'coachChat:send' handler must be registered").toBeTruthy()
  await handler!({}, 'call-1', message, 'advisor', false)
}

beforeEach(() => {
  lastStreamArgs = null
  salesBrainProfile = ''
})

describe('coachChat:send — the total prompt bound is actually applied (BUG-108)', () => {
  it('the fixture really does overflow without a bound', () => {
    // Non-vacuity guard. If this stops being true the assertions below prove
    // nothing, because there would be nothing to trim.
    const transcriptChars = testCall.segments.reduce((n, s) => n + `Speaker ${s.speaker + 1}: ${s.text}`.length + 1, 0)
    const historyChars = testCall.coachChat.reduce((n, m) => n + m.text.length, 0)
    expect(transcriptChars).toBeGreaterThan(100_000)
    expect(historyChars).toBe(480_000)
    expect(transcriptChars + historyChars + 8_000).toBeGreaterThan(BUDGET)
  })

  it('sends a prompt within the budget', async () => {
    await send('m'.repeat(8_000))
    expect(lastStreamArgs).toBeTruthy()
    expect(
      promptChars(lastStreamArgs!),
      'the prompt handed to streamWithFallback still exceeds the budget — a 400 here ' +
        'blacklists every model across every purpose for 4 hours'
    ).toBeLessThanOrEqual(BUDGET)
  })

  it('keeps the END of the call and drops the start', async () => {
    await send('what did they commit to?')
    const { system } = lastStreamArgs!
    expect(system, 'the most recent speech must survive').toContain(CLOSING)
    expect(system, 'the opening is what should give way').not.toContain(OPENING)
  })

  it('tells the model the transcript is partial', async () => {
    await send('summarise the call')
    expect(lastStreamArgs!.system).toContain("[Context truncated to fit the model's limit")
  })

  it('drops history oldest-first and never leaves it starting on an assistant turn', async () => {
    await send('m'.repeat(8_000))
    const replayed = lastStreamArgs!.messages
    expect(replayed.length).toBeLessThan(41)
    expect(replayed[0].role).toBe('user')
    // The turn the rep just typed is always last and always intact.
    expect(replayed[replayed.length - 1].content).toBe('m'.repeat(8_000))
  })

  it("when the transcript ITSELF must shrink, the send path cuts its head — not its tail", async () => {
    // Without this case the send path's trim DIRECTION is untested: with an
    // ordinary fixed floor, dropping history alone brings the prompt under
    // budget and the transcript is never touched, so CLOSING survives purely
    // because callTranscript() keeps the END. Flipping the send path to
    // 'tail' then changed nothing and every assertion still passed — proving
    // the direction was unasserted rather than correct. A big Sales Brain
    // profile (injected with no cap of its own) pushes the FIXED floor up
    // until the transcript is the only thing left to cut.
    salesBrainProfile = 'P'.repeat(260_000)
    await send('what did they commit to?')

    const { system } = lastStreamArgs!
    expect(system).toContain('P'.repeat(1_000)) // the floor really is in there
    // Nothing but the transcript can absorb the overflow at this point.
    expect(system, 'the most recent speech must still survive').toContain(CLOSING)
    expect(system).not.toContain(OPENING)
    expect(system).toContain("[Context truncated to fit the model's limit")
    expect(promptChars(lastStreamArgs!)).toBeLessThanOrEqual(BUDGET)
    // And the transcript genuinely had to give — otherwise this case is
    // exercising the same path as the test above.
    const transcriptChars = testCall.segments.reduce(
      (n, s) => n + `Speaker ${s.speaker + 1}: ${s.text}`.length + 1,
      0
    )
    expect(system.length).toBeLessThan(260_000 + transcriptChars)
  })

  it('surfaces a broken pairing invariant instead of silently repairing it', async () => {
    // The repair is right for a live call, but a silent repair makes the
    // underlying breakage undetectable — the only evidence would be a turn
    // quietly going missing. Prove the warning actually fires, rather than
    // trusting that it would: a signal nobody has watched fire is
    // indistinguishable from one that cannot.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const original = testCall.coachChat
    // A single unpaired assistant turn at the head — exactly what an odd cap
    // or a lone append would produce. NOTE the length must stay at
    // MAX_HISTORY_MESSAGES (40): the send path slices the LAST 40, so an
    // orphan prepended to a full 40 is sliced straight back off and never
    // reaches the budget at all. The first draft of this test did that and
    // failed — the fixture, not the code.
    testCall.coachChat = [
      { id: 'orphan', role: 'assistant' as const, text: 'orphaned reply', createdAt: '2026-08-01T00:00:00.000Z', mode: 'advisor' as const },
      ...original.slice(0, 39)
    ]
    try {
      await send('what did they commit to?')
      const said = warn.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(said).toContain('pairing invariant is broken upstream')
      expect(said).toContain('has NOT been fixed')
      // Repaired as well as reported — the turn still goes out valid.
      expect(lastStreamArgs!.messages[0].role).toBe('user')
    } finally {
      testCall.coachChat = original
      warn.mockRestore()
    }
  })

  it('does NOT warn on ordinary well-formed history', async () => {
    // Benign states are never counted — otherwise the real signal drowns.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await send('m'.repeat(8_000))
      const said = warn.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(said).not.toContain('pairing invariant')
    } finally {
      warn.mockRestore()
    }
  })

  it('files a memory extraction against the MINTED user id, never a positional guess (BUG-110)', async () => {
    // The old code read coachChat[length - 2], which is the rep's message
    // only while the tail is a complete user+assistant pair — an invariant
    // nothing enforces. Landing one off would file a memory extracted from
    // the REP's words under the COACH's id: no error, no rejection, just
    // wrong provenance in Sales Brain data.
    //
    // BE PRECISE ABOUT WHAT THIS PROVES, because it is easy to overclaim.
    // In production the two mechanisms COINCIDE: appendCoachChatTurn appends
    // the pair and returns those same ids, so on well-formed data
    // `coachChat[length - 2].id === userMessageId` and no behavioural test
    // could separate them. This test discriminates only because the MOCK
    // decouples the two sources — it returns 'minted-user-id' while the
    // array it also returns holds m0..m39. That state is one the real
    // appendCoachChatTurn cannot produce.
    //
    // So this asserts WHICH SOURCE THE CODE READS (a handed-back id, not a
    // computed index) — a real regression guard if someone later "simplifies"
    // back to arithmetic. It does NOT assert that arithmetic gives a wrong
    // answer today; it doesn't. The M28 session's equivalent Rise test can't
    // discriminate at all, because its fixture keeps the two sources in
    // agreement — the asymmetry is a property of the FIXTURES, not the code,
    // so neither result generalises to "hardening is/isn't testable".
    runMemoryExtractionForChatMessage.mockClear()
    await send('their CFO signs off on anything over 50k')
    expect(runMemoryExtractionForChatMessage).toHaveBeenCalledTimes(1)
    const [, passedId] = runMemoryExtractionForChatMessage.mock.calls[0] as unknown as [string, string, string]
    expect(passedId).toBe('minted-user-id')
    expect(passedId).not.toBe('minted-assistant-id')
  })

  it('never truncates the message the rep just typed', async () => {
    const typed = 'q'.repeat(8_000)
    await send(typed)
    const last = lastStreamArgs!.messages[lastStreamArgs!.messages.length - 1]
    expect(last.content).toHaveLength(8_000)
    expect(last.content).toBe(typed)
  })
})
