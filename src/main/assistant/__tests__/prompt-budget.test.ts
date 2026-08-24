// BUG-108 — the total prompt bound.
//
// Every prompt input was capped individually and nothing capped the sum.
// The fixtures below are built from the REAL caps on main — 100,000
// transcript, 8,000 per user turn (the entry cap), 16,000 per assistant turn
// (MAX_CHAT_TEXT, which the replay path does not re-enforce) — deliberately
// NOT 8,000 across the board. A fixture built on 8,000 everywhere passes
// against a bound that a real session can still blow.
import { describe, expect, it } from 'vitest'
import {
  fitPromptToBudget,
  budgetCharsFor,
  truncationMarker,
  CHARS_PER_TOKEN,
  PROMPT_WINDOW_FRACTION,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  type BudgetMessage
} from '../prompt-budget'

const msg = (role: 'user' | 'assistant', content: string): BudgetMessage => ({ role, content })

const sizeOf = (systemFixed: string, trimmable: string, history: BudgetMessage[], message: string): number =>
  systemFixed.length + trimmable.length + message.length + history.reduce((n, h) => n + h.content.length, 0)

/** The real shipped caps, as verified on main. */
const CAP = {
  transcript: 100_000,
  userTurn: 8_000, // coaching-chat-ipc.ts:141
  assistantTurn: 16_000, // calls-fs.ts MAX_CHAT_TEXT
  historyCount: 40 // MAX_HISTORY_MESSAGES
}

/** History as it is actually persisted: user/assistant PAIRS, the user turn
 *  bounded by the entry cap and the assistant turn by the persistence cap. */
function worstCaseHistory(): BudgetMessage[] {
  return Array.from({ length: CAP.historyCount }, (_, i) =>
    i % 2 === 0
      ? msg('user', `u${i}`.padEnd(CAP.userTurn, 'u'))
      : msg('assistant', `a${i}`.padEnd(CAP.assistantTurn, 'a'))
  )
}

describe('fitPromptToBudget', () => {
  it('leaves an ordinary turn completely untouched', () => {
    const input = {
      systemFixed: 'You are a sales coach.',
      trimmable: 'Speaker 1: hello',
      history: [msg('user', 'hi'), msg('assistant', 'hello')],
      message: 'why did I score 3 on discovery?'
    }
    const out = fitPromptToBudget(input, 10_000, 'head')
    expect(out.trimmable).toBe(input.trimmable)
    expect(out.history).toEqual(input.history)
    expect(out.trim.trimmed).toBe(false)
    expect(out.fits).toBe(true)
  })

  it('drops history OLDEST first, keeping the most recent turns', () => {
    const history = Array.from({ length: 10 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `turn-${i}-${'x'.repeat(100)}`)
    )
    const out = fitPromptToBudget({ systemFixed: 'sys', trimmable: '', history, message: 'now' }, 400, 'head')
    expect(out.history.length).toBeLessThan(10)
    // Whatever survived must be the TAIL of the original.
    expect(out.history).toEqual(history.slice(history.length - out.history.length))
  })

  it('drops history BEFORE touching the transcript — the founder-decided order', () => {
    const trimmable = 'T'.repeat(1_000)
    const history = [msg('user', 'u'.repeat(1_000)), msg('assistant', 'a'.repeat(1_000))]
    // Budget fits the transcript + message but not the history.
    const out = fitPromptToBudget({ systemFixed: '', trimmable, history, message: 'm' }, 1_100, 'head')
    expect(out.trim.historyMessagesDropped).toBe(2)
    expect(out.trim.trimmableCharsDropped, 'the transcript should survive intact').toBe(0)
    expect(out.trimmable).toBe(trimmable)
  })

  it('never trims the current message — the one degradation the rep would notice', () => {
    const message = 'z'.repeat(5_000)
    const out = fitPromptToBudget({ systemFixed: '', trimmable: 'x'.repeat(5_000), history: [], message }, 1_000, 'head')
    expect(out.trimmable.length).toBeLessThan(5_000)
    expect(message).toHaveLength(5_000)
  })

  it("trimFrom 'head' keeps the END of the call — NOT the start", () => {
    // The direction is the whole point of the founder's decision, so this
    // asserts on identifiable content at both ends. A length-only assertion
    // would pass with either direction and prove nothing.
    const first = 'Speaker 1: OPENING-SMALL-TALK\n'
    const last = '\nSpeaker 2: send the contract Friday'
    const trimmable = first + 'x'.repeat(10_000) + last
    const out = fitPromptToBudget({ systemFixed: '', trimmable, history: [], message: '' }, 500, 'head')
    expect(out.trimmable.endsWith(last), 'the most recent speech must survive').toBe(true)
    expect(out.trimmable).not.toContain('OPENING-SMALL-TALK')
    expect(out.trim.trimmableCharsDropped).toBeGreaterThan(0)
  })

  it("trimFrom 'tail' keeps the START — the direction Rise needs for SCOPE_RULE", () => {
    const head = 'SCOPE RULE: only this client.'
    const trimmable = head + 'A'.repeat(10_000)
    const out = fitPromptToBudget({ systemFixed: '', trimmable, history: [], message: 'q' }, 500, 'tail')
    expect(out.trimmable.startsWith(head)).toBe(true)
    expect(out.trimmable.length).toBeLessThan(trimmable.length)
  })

  it('never leaves history starting on an assistant turn', () => {
    // Turns are persisted in user/assistant pairs, so an unguarded
    // one-at-a-time drop can land on an odd boundary and hand the provider a
    // non-alternating sequence, which they reject outright.
    const history = Array.from({ length: 8 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(100))
    )
    // Sweep every budget that forces a different number of drops, so this
    // cannot pass by landing on one lucky boundary.
    for (let budget = 0; budget <= 800; budget += 50) {
      const out = fitPromptToBudget({ systemFixed: '', trimmable: '', history, message: '' }, budget, 'head')
      if (out.history.length > 0) {
        expect(out.history[0].role, `budget ${budget} left a leading assistant turn`).toBe('user')
      }
    }
  })

  describe('historyStartedOnAssistant — the repair must not also hide the breakage', () => {
    it('is TRUE when the history handed in already began on an assistant turn', () => {
      const history = [msg('assistant', 'orphaned reply'), msg('user', 'hi'), msg('assistant', 'hello')]
      const out = fitPromptToBudget({ systemFixed: '', trimmable: '', history, message: 'q' }, 10_000, 'head')
      expect(out.historyStartedOnAssistant).toBe(true)
      // Repaired as well as reported — the turn still goes out valid.
      expect(out.history[0].role).toBe('user')
    })

    it('is FALSE for the routine odd-drop boundary — benign states are not counted', () => {
      // Well-formed pairs. The guard still fires at some budgets (that is its
      // ordinary job), but that must NOT be reported as an invariant
      // violation, or the real signal drowns in noise.
      const history = Array.from({ length: 8 }, (_, i) =>
        msg(i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(100))
      )
      let sawAGuardFire = false
      for (let budget = 0; budget <= 800; budget += 50) {
        const out = fitPromptToBudget({ systemFixed: '', trimmable: '', history, message: '' }, budget, 'head')
        expect(out.historyStartedOnAssistant, `budget ${budget} falsely reported a violation`).toBe(false)
        // Detect a guard firing by asking whether one FEWER drop would also
        // have fit: if so, the fitting loop had already stopped and the extra
        // drop can only have come from the guard. (Parity of the drop count
        // does NOT work — the guard increments the counter, flipping an odd
        // loop-drop back to even, which is what the first draft of this test
        // got wrong and why the non-vacuity check below exists at all.)
        const dropped = out.trim.historyMessagesDropped
        if (dropped > 0) {
          const oneFewer = history.slice(dropped - 1)
          const size = oneFewer.reduce((n, h) => n + h.content.length, 0)
          if (size <= budget) sawAGuardFire = true
        }
      }
      // Non-vacuity: if the guard never fired across the sweep, this test
      // proved nothing about distinguishing the two cases.
      expect(sawAGuardFire, 'the sweep never exercised the guard at all').toBe(true)
    })

    it('is FALSE on ordinary well-formed input that is not trimmed at all', () => {
      const out = fitPromptToBudget(
        { systemFixed: 'sys', trimmable: '', history: [msg('user', 'hi'), msg('assistant', 'yo')], message: 'q' },
        10_000,
        'head'
      )
      expect(out.historyStartedOnAssistant).toBe(false)
      expect(out.trim.trimmed).toBe(false)
    })
  })

  it('the worst case built from the REAL caps actually fits afterwards', () => {
    const systemFixed = 'S'.repeat(35_000) // scorecard + KYC + past calls + notes + Sales Brain
    const trimmable = 'T'.repeat(CAP.transcript)
    const history = worstCaseHistory()
    const message = 'm'.repeat(CAP.userTurn)
    const budgetChars = budgetCharsFor(DEFAULT_CONTEXT_WINDOW_TOKENS)

    const before = sizeOf(systemFixed, trimmable, history, message)
    // 480,000 history + 100,000 transcript + 8,000 message + 35,000 fixed.
    expect(before, 'the fixture must reproduce the real overflow').toBeGreaterThan(budgetChars)
    expect(before).toBeGreaterThan(600_000)

    const out = fitPromptToBudget({ systemFixed, trimmable, history, message }, budgetChars, 'head')
    const after = sizeOf(systemFixed, out.trimmable, out.history, message)
    expect(
      after,
      'the trimmed prompt still exceeds the budget — a 400 would blacklist every model in the chain'
    ).toBeLessThanOrEqual(budgetChars)
    expect(out.fits).toBe(true)
    expect(out.trim.trimmed).toBe(true)
  })

  it('reports fits:false when the fixed floor alone overflows, rather than looking fitted', () => {
    const out = fitPromptToBudget(
      { systemFixed: 'S'.repeat(500_000), trimmable: 'T'.repeat(1_000), history: [], message: 'm' },
      100_000,
      'head'
    )
    expect(out.fits).toBe(false)
    expect(out.trimmable, 'everything cuttable must actually be cut first').toBe('')
  })

  it('the budget leaves real headroom below the declared window', () => {
    const chars = budgetCharsFor(DEFAULT_CONTEXT_WINDOW_TOKENS)
    expect(chars).toBe(358_400)
    expect(chars / CHARS_PER_TOKEN).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS * PROMPT_WINDOW_FRACTION)
  })

  it('a long-but-ordinary session is trimmed by dropping history, transcript intact', () => {
    // Worth stating plainly, because the first draft of this test asserted
    // the opposite and failed: 358,400 is LESS than a 100,000 transcript plus
    // 40 turns at the 8,000 entry cap (420,000), so the bound is NOT a no-op
    // on a long session — it really does bite. What matters is that it bites
    // in the founder-decided order, so the thing a rep is asking about (the
    // call itself, most recent first) is the last thing to go.
    const systemFixed = 'S'.repeat(35_000)
    const trimmable = 'T'.repeat(CAP.transcript)
    const history = Array.from({ length: CAP.historyCount }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', 'h'.repeat(CAP.userTurn))
    )
    const message = 'm'.repeat(CAP.userTurn)
    const budgetChars = budgetCharsFor(DEFAULT_CONTEXT_WINDOW_TOKENS)

    expect(sizeOf(systemFixed, trimmable, history, message)).toBeGreaterThan(budgetChars)

    const out = fitPromptToBudget({ systemFixed, trimmable, history, message }, budgetChars, 'head')
    expect(out.trim.historyMessagesDropped).toBeGreaterThan(0)
    expect(out.trimmable, 'the whole transcript should still fit once history gives way').toBe(trimmable)
    expect(out.trim.trimmableCharsDropped).toBe(0)
    // Plenty of the conversation still survives — this is a trim, not a wipe.
    expect(out.history.length).toBeGreaterThan(CAP.historyCount / 2)
    expect(out.fits).toBe(true)
  })

  it('the truncation marker names what was lost, in one shared wording', () => {
    expect(truncationMarker('the earlier part of this call')).toBe(
      "[Context truncated to fit the model's limit — the earlier part of this call was omitted.]"
    )
  })
})
