// BUG-167 — the Sales Brain stored facts about the RECORDING, not the business.
//
// Real entries found in the founder's store at confidence 1.0:
//   [rep/communication-style] "Speaker 0 speaks first."
//   [rep/communication-style] "Speaker 1 speaks in a slightly different style
//                              than Speaker 0."
//   [rep/communication-style] "Speaker 1 covers their words while speaking."
// All three describe the FORMAT of the model's own input — how the transcript
// labels turns — filed as durable facts about how the rep communicates. They
// then feed coaching and live cues.
//
// The prompt already asks the model not to do this. It does it anyway, so the
// guard is structural: no genuine fact about a rep, their company or their
// client ever needs to name "Speaker 3".
import { describe, expect, it } from 'vitest'
import { verifyAndBuild } from '../memory/extraction'

// A source text the quotes genuinely appear in, so the evidence check passes
// and the speaker-label rule is the only thing that can reject them.
const SOURCE = [
  'REP (the user): Speaker 0 speaks first on every one of these calls, I have noticed.',
  'OTHER PARTY (the client): Your pricing is well above what Gong quoted us last month.',
  'REP (the user): I tend to open with a short discovery question before any pricing talk.'
].join('\n')

const build = (statement: string, quote: string, category = 'communication-style', scopeKind = 'rep') =>
  verifyAndBuild({ statement, quote, category, scopeKind, confidence: 1, importance: 5 }, SOURCE, null)

describe('BUG-167 — a memory that names a speaker label is about the transcript', () => {
  it.each([
    'Speaker 0 speaks first.',
    'Speaker 1 speaks in a slightly different style than Speaker 0.',
    'Speaker 1 covers their words while speaking.',
    'speaker 2 interrupts often.',
    'The rep is Speaker 0 on this call.',
    'Speakers 0 and 1 alternate evenly.'
  ])('rejects %j', (statement) => {
    expect(build(statement, 'Speaker 0 speaks first on every one of these calls')).toBeNull()
  })

  // THE CONTROL. Without these the rule could be "reject everything" and every
  // assertion above would still pass.
  it('still accepts a real fact about how the rep sells', () => {
    const out = build(
      'The rep opens with a short discovery question before discussing pricing.',
      'I tend to open with a short discovery question before any pricing talk',
      'selling-pattern'
    )
    expect(out).not.toBeNull()
    expect(out?.statement).toContain('discovery question')
  })

  it('does not catch an unrelated word that merely ends in "speakers"', () => {
    const src = 'REP (the user): We sell loudspeakers 2000 units at a time to retail chains.'
    const out = verifyAndBuild(
      {
        statement: 'The rep sells loudspeakers 2000 units at a time.',
        quote: 'We sell loudspeakers 2000 units at a time to retail chains',
        category: 'selling-pattern',
        scopeKind: 'rep',
        confidence: 1,
        importance: 5
      },
      src,
      null
    )
    expect(out).not.toBeNull()
  })
})
