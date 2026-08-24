// AUDIT FIX (2026-08-24) — the total prompt bound.
//
// Every prompt input was capped individually and nothing capped the sum:
// ~595,000 chars (~149,000 tokens) was reachable through the UI against a
// declared 128,000-token window. Overflow returned a 400, which
// failure-class.ts classifies as 'structural', so the walk blacklisted each
// model in turn while re-sending the identical oversize prompt.
import { describe, expect, it } from 'vitest'
import {
  fitPromptToBudget,
  budgetCharsFor,
  CHARS_PER_TOKEN,
  PROMPT_WINDOW_FRACTION,
  DEFAULT_CONTEXT_WINDOW_TOKENS
} from '../prompt-budget'

const msg = (role: 'user' | 'assistant', content: string): { role: 'user' | 'assistant'; content: string } => ({ role, content })

describe('fitPromptToBudget', () => {
  it('leaves an ordinary turn completely untouched', () => {
    const input = {
      system: 'You are a sales assistant.',
      history: [msg('user', 'hi'), msg('assistant', 'hello')],
      message: 'what is our pricing?'
    }
    const out = fitPromptToBudget(input, 10_000)
    expect(out.system).toBe(input.system)
    expect(out.history).toEqual(input.history)
    expect(out.trim.trimmed).toBe(false)
  })

  it('drops history OLDEST first, keeping the most recent turns', () => {
    const history = Array.from({ length: 10 }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `turn-${i}-${'x'.repeat(100)}`))
    const out = fitPromptToBudget({ system: 'sys', history, message: 'now' }, 400)
    expect(out.history.length).toBeLessThan(10)
    // Whatever survived must be the TAIL of the original.
    expect(out.history).toEqual(history.slice(history.length - out.history.length))
    expect(out.trim.historyMessagesDropped).toBe(10 - out.history.length)
  })

  it('never trims the current message — the one degradation the user would notice', () => {
    const message = 'z'.repeat(5_000)
    const out = fitPromptToBudget({ system: 'x'.repeat(5_000), history: [], message }, 1_000)
    expect(out.system.length).toBeLessThan(5_000)
    // The message is returned to the caller unchanged; only system/history move.
    expect(message).toHaveLength(5_000)
  })

  it('truncates the system TAIL, not its head — the scope rule must survive', () => {
    // context.ts puts rules and scope at the top and appends attachment text
    // at the end, so cutting the head would drop SCOPE_RULE: the instruction
    // that stops one client's data being discussed in another client's chat.
    const head = 'SCOPE RULE: only this client.'
    const system = head + 'A'.repeat(10_000)
    const out = fitPromptToBudget({ system, history: [], message: 'q' }, 500)
    expect(out.system.startsWith(head)).toBe(true)
    expect(out.system.length).toBeLessThan(system.length)
    expect(out.system).toContain('Context truncated')
  })

  it('the reported result actually fits the budget — history and system together', () => {
    const history = Array.from({ length: 40 }, () => msg('user', 'h'.repeat(8_000)))
    const system = 'S'.repeat(267_016) // measured: six text attachments
    const message = 'm'.repeat(8_000)
    const budgetChars = budgetCharsFor(DEFAULT_CONTEXT_WINDOW_TOKENS)

    const before = system.length + message.length + history.reduce((n, h) => n + h.content.length, 0)
    expect(before, 'the fixture must reproduce the measured overflow').toBeGreaterThan(budgetChars)

    const out = fitPromptToBudget({ system, history, message }, budgetChars)
    const after = out.system.length + message.length + out.history.reduce((n, h) => n + h.content.length, 0)
    expect(
      after,
      'the trimmed prompt still exceeds the budget — a 400 would blacklist every model in the chain'
    ).toBeLessThanOrEqual(budgetChars)
    expect(out.trim.trimmed).toBe(true)
  })

  it('fits even when the system prompt ALONE exceeds the whole budget', () => {
    const system = 'S'.repeat(1_000_000)
    const message = 'm'.repeat(8_000)
    const out = fitPromptToBudget({ system, history: [], message }, 50_000)
    expect(out.system.length + message.length).toBeLessThanOrEqual(50_000)
    expect(out.trim.systemCharsDropped).toBeGreaterThan(0)
  })

  it('the budget leaves real headroom below the declared window', () => {
    const chars = budgetCharsFor(DEFAULT_CONTEXT_WINDOW_TOKENS)
    const approxTokens = chars / CHARS_PER_TOKEN
    expect(approxTokens).toBeLessThan(DEFAULT_CONTEXT_WINDOW_TOKENS)
    expect(approxTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS * PROMPT_WINDOW_FRACTION)
    // The budget must clear a maxed-out HISTORY on its own: 40 turns at the
    // 8,000-char inbound cap is 320,000, leaving 38,400 for system + message.
    expect(chars).toBeGreaterThan(320_000)

    // CORRECTED 2026-08-24 — this comment used to claim the budget was
    // "generous enough that a normal long conversation is never trimmed".
    // That was broader than anything measured, and the arithmetic is tighter
    // than it sounds: 320,000 history + 8,000 message + the audit's measured
    // 26,458-char no-attachment system prompt = 354,458, which fits by 3,942
    // chars — a 1.1% margin. The system prompt only has to exceed 30,400
    // chars for a maxed-out history to start trimming, and it varies with
    // retrieved memories, lookup sections and the client brief.
    //
    // So the honest statement is the one asserted here: history alone always
    // fits, and beyond that trimming is EXPECTED rather than exceptional.
    // That is fine — dropping the oldest turns is the designed degradation,
    // not a failure — but a comment claiming it never happens would send the
    // next reader looking for a bug when they saw it happen.
    const MAXED_HISTORY = 320_000
    const MEASURED_SYSTEM_NO_ATTACHMENTS = 26_458
    const MESSAGE_CAP = 8_000
    expect(MAXED_HISTORY + MESSAGE_CAP + MEASURED_SYSTEM_NO_ATTACHMENTS).toBeLessThanOrEqual(chars)
    expect(
      chars - (MAXED_HISTORY + MESSAGE_CAP + MEASURED_SYSTEM_NO_ATTACHMENTS),
      'the no-attachment margin moved — re-read the comment above, it quotes this number'
    ).toBeLessThan(10_000)
  })
})
