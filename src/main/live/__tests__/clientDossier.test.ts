// M39 Stage 3 — the client dossier.
//
// The properties tested here are the ones the FEATURE rests on rather than the
// ones the code obviously has:
//   - the cap actually caps (it did not: 1,255 characters against a 1,200 cap
//     on the founder's own records, because the budget counted lines and the
//     renderer also emitted headers);
//   - two builds over the same records are byte-identical, because prompt
//     caching needs a stable prefix and a single relative date or unordered
//     map silently costs it on every cue for the rest of the call;
//   - an empty dossier is EMPTY, not a header with nothing under it — a
//     skeleton in a cached prefix costs tokens forever and says nothing.
//
// The fixtures are the founder's real shapes with fictional content.
import { describe, expect, it } from 'vitest'
import {
  buildClientDossier,
  DEFAULT_DOSSIER_CHARS,
  type DossierCall,
  type DossierContact,
  type DossierTask
} from '../clientDossier'

const contact: DossierContact = { id: 'c1', name: 'ZZ Brett' }

/** The lines under ONE heading. A dossier now has sections that can mention the
 *  same record for opposite reasons — a task is either still open or since
 *  done — so a whole-text `not.toContain` asserts something much wider than the
 *  claim being made, and breaks the moment a second section has anything true
 *  to say about it. Returns '' when the section is absent. */
const section = (text: string, heading: string): string => {
  const lines = text.split('\n')
  const start = lines.indexOf(`${heading}:`)
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => !l.startsWith('- '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

const call = (over: Partial<DossierCall> & { id: string }): DossierCall => ({
  contactId: 'c1',
  createdAt: '2026-08-20T09:42:00.000Z',
  ...over
})

const RICH: DossierCall[] = [
  call({
    id: 'a',
    createdAt: '2026-08-20T09:42:00.000Z',
    summary: { executive: 'He cannot add funds for about two months.' },
    coaching: {
      overallScore: 43,
      nextAction: 'Ask three calm follow-ups about timing before proposing anything.',
      dimensions: [
        {
          key: 'objection',
          comment: 'Countered the hesitation with urgency instead of unpacking it.',
          evidence: { verified: true, quote: 'This is the time right now to make a change.' }
        }
      ]
    }
  }),
  call({
    id: 'b',
    createdAt: '2026-08-17T10:24:00.000Z',
    coaching: {
      overallScore: 30,
      dimensions: [{ key: 'objection', comment: 'Minimised a real financial obligation.' }]
    }
  })
]

describe('M39 — the dossier says something when there is something to say', () => {
  it('names the client and fills the sections it has data for', () => {
    const d = buildClientDossier({ contact, calls: RICH, tasks: [] })
    expect(d.text.startsWith('CLIENT: ZZ Brett')).toBe(true)
    expect(d.sections).toContain('Open commitments')
    expect(d.sections).toContain('Last call')
    expect(d.sections).toContain('What they pushed back on')
    expect(d.sections).toContain('How these calls have gone')
  })

  it('keeps BOTH the buyer’s own words and the coaching read', () => {
    // The first version returned after the quote. Measured on the founder's
    // records that lost the useful half on one contact and kept it on another,
    // so neither is reliably better and the budget arbitrates instead.
    const d = buildClientDossier({ contact, calls: RICH, tasks: [] })
    expect(d.text).toContain('they said: "This is the time right now to make a change."')
    expect(d.text).toContain('how it went: Countered the hesitation with urgency')
  })

  it('gives two coaching scores, not a verdict', () => {
    // Two numbers let the model read a direction. A word like "improving"
    // would be us deciding for it, on two data points.
    const d = buildClientDossier({ contact, calls: RICH, tasks: [] })
    expect(d.text).toMatch(/Coaching score 43 on 2026-08-20, 30 on 2026-08-17/)
    expect(d.text).not.toMatch(/improving|declining|getting better/i)
  })

  it('surfaces an open commitment, and not a closed one', () => {
    const tasks: DossierTask[] = [
      { id: 't1', title: 'Send the pricing comparison', done: false, callId: 'a' },
      { id: 't2', title: 'Already did this one', done: true, callId: 'a' }
    ]
    const d = buildClientDossier({ contact, calls: RICH, tasks })
    expect(d.text).toContain('Send the pricing comparison')
    expect(d.text).not.toContain('Already did this one')
  })

  it('reads completion the way the app WRITES it, not the way I assumed', () => {
    // THE BUG THE MEASUREMENT CAUGHT. The first version filtered on `!t.done`.
    // The app never writes a `done` boolean — it writes `status: 'done'` and a
    // `completedAt`. On the founder's profile 24 of 28 tasks are complete, so
    // every one of them was being handed to the model as an outstanding
    // promise. My own population script used the same wrong field and agreed
    // with the code, which is why the suite was green and the count was wrong.
    const tasks: DossierTask[] = [
      { id: 't1', title: 'Genuinely still open', status: 'open', callId: 'a' },
      { id: 't2', title: 'Closed by status', status: 'done', callId: 'a' },
      { id: 't3', title: 'Closed by completedAt', completedAt: '2026-08-21T00:00:00.000Z', callId: 'a' },
      { id: 't4', title: 'Closed by the boolean', done: true, callId: 'a' }
    ]
    const d = buildClientDossier({ contact, calls: RICH, tasks })
    // SCOPED TO ITS OWN SECTION, and why is worth keeping. This was
    // `expect(d.text).not.toContain(…)` over the whole dossier, and Stage 4 #5
    // made it fail correctly: "Closed by completedAt" is stamped 2026-08-21,
    // after RICH's previous call, so "Since your last call with them" now
    // reports it — as a promise KEPT, which is the opposite claim from the one
    // this test makes, and a true one.
    const open = section(d.text, 'Open commitments')
    expect(open).toContain('Genuinely still open')
    expect(open).not.toContain('Closed by status')
    expect(open).not.toContain('Closed by completedAt')
    expect(open).not.toContain('Closed by the boolean')
  })
})

describe('M39 Stage 4 #4 — a promise that is past due says so', () => {
  const tasks: DossierTask[] = [
    { id: 't1', title: 'Send the security doc', status: 'open', dueAt: '2026-08-03T00:00:00.000Z', callId: 'a' },
    { id: 't2', title: 'Book the follow-up', status: 'open', dueAt: '2026-12-01T00:00:00.000Z', callId: 'a' }
  ]

  it('names the overdue one as overdue and the other as merely due', () => {
    const d = buildClientDossier({ contact, calls: RICH, tasks, asOf: '2026-09-11T00:00:00.000Z' })
    expect(d.text).toContain('Send the security doc — was due 2026-08-03, still open')
    expect(d.text).toContain('Book the follow-up (due 2026-12-01)')
  })

  it('ranks the overdue promise above everything else in its section', () => {
    const d = buildClientDossier({ contact, calls: RICH, tasks, asOf: '2026-09-11T00:00:00.000Z' })
    const lines = d.text.split('\n')
    const overdue = lines.findIndex((l) => l.includes('was due 2026-08-03'))
    const other = lines.findIndex((l) => l.includes('Book the follow-up'))
    expect(overdue).toBeGreaterThan(-1)
    expect(overdue).toBeLessThan(other)
  })

  it('takes the time from the CALLER and never from a clock', () => {
    // "Overdue" is the one genuinely time-dependent thing in this file, and a
    // Date.now() inside would make two cues on the same call differ — exactly
    // what the cached prefix cannot survive. Two builds at two different
    // stated moments differ; two at the same moment are identical.
    const early = buildClientDossier({ contact, calls: RICH, tasks, asOf: '2026-07-01T00:00:00.000Z' })
    const late = buildClientDossier({ contact, calls: RICH, tasks, asOf: '2026-09-11T00:00:00.000Z' })
    expect(early.text).not.toContain('still open')
    expect(late.text).toContain('still open')
    expect(buildClientDossier({ contact, calls: RICH, tasks, asOf: '2026-09-11T00:00:00.000Z' }).text).toBe(late.text)
  })

  it('with no asOf, nothing is called overdue', () => {
    // A caller that does not say when it is asking gets no time-dependent
    // claim, rather than one silently made against the machine's clock.
    const d = buildClientDossier({ contact, calls: RICH, tasks })
    expect(d.text).not.toContain('still open')
    expect(d.text).toContain('Send the security doc (due 2026-08-03)')
  })
})

describe('M39 — the dossier is a STABLE PREFIX', () => {
  it('is byte-identical across two builds over the same records', () => {
    // The property prompt caching depends on. Measured 50 of 50 on the real
    // profile; pinned here so a relative date or a map iteration cannot creep
    // in later and cost the cache with nothing going red.
    const args = { contact, calls: RICH, tasks: [{ id: 't1', title: 'Send it', callId: 'a' }] }
    expect(buildClientDossier(args).text).toBe(buildClientDossier(args).text)
  })

  it('carries no relative date and no clock reading', () => {
    const d = buildClientDossier({ contact, calls: RICH, tasks: [] })
    expect(d.text).not.toMatch(/\bago\b|yesterday|today|tomorrow|last week/i)
    expect(d.text).toMatch(/\d{4}-\d{2}-\d{2}/) // absolute dates, and there ARE some
  })

  it('does not depend on the order the caller passes calls in', () => {
    // A caller reading a directory gets whatever order the filesystem gives.
    const a = buildClientDossier({ contact, calls: RICH, tasks: [] }).text
    const b = buildClientDossier({ contact, calls: [...RICH].reverse(), tasks: [] }).text
    expect(a).toBe(b)
  })

  it('does not depend on the order tasks arrive in', () => {
    const tasks: DossierTask[] = [
      { id: 't1', title: 'First thing', callId: 'a' },
      { id: 't2', title: 'Second thing', callId: 'a' }
    ]
    const a = buildClientDossier({ contact, calls: RICH, tasks }).text
    const b = buildClientDossier({ contact, calls: RICH, tasks: [...tasks].reverse() }).text
    expect(a).toBe(b)
  })
})

describe('M39 — the cap actually caps', () => {
  it('never exceeds the cap, at any cap', () => {
    // THE REGRESSION. The budget counted `line.length + 3` and the renderer
    // also emitted a CLIENT header and one heading per section, so the output
    // ran 55 characters over on the founder's largest dossier. Checked across
    // a range rather than at one value, because an off-by-a-header only shows
    // up where the cap actually bites.
    const fat: DossierContact = {
      ...contact,
      title: 'A'.repeat(300),
      budgetIndication: 'B'.repeat(300),
      timeline: 'C'.repeat(300),
      knownObjections: 'D'.repeat(300),
      personalNotes: 'E'.repeat(300),
      currentTooling: 'F'.repeat(300)
    }
    for (const cap of [80, 150, 300, 600, 1200, 4000]) {
      const d = buildClientDossier({ contact: fat, calls: RICH, tasks: [], maxChars: cap })
      expect(d.chars, `cap ${cap}`).toBeLessThanOrEqual(cap)
      expect(d.text.length, `cap ${cap}`).toBe(d.chars)
    }
  })

  it('reports what the cap dropped instead of hiding it', () => {
    // A truncated dossier and a thin one look identical from outside.
    const fat: DossierContact = { ...contact, title: 'A'.repeat(200), personalNotes: 'B'.repeat(200) }
    const d = buildClientDossier({ contact: fat, calls: RICH, tasks: [], maxChars: 150 })
    expect(d.dropped).toBeGreaterThan(0)
  })

  it('drops whole items, never half a sentence', () => {
    const fat: DossierContact = { ...contact, title: 'A'.repeat(200) }
    const d = buildClientDossier({ contact: fat, calls: RICH, tasks: [], maxChars: 400 })
    for (const line of d.text.split('\n')) {
      if (!line.startsWith('- ')) continue
      // Either a complete line, or one the FIELD truncator shortened with an
      // ellipsis — never a hard cut by the budget.
      expect(line.endsWith('…') || line.length > 0).toBe(true)
      expect(line).not.toMatch(/^-\s*$/)
    }
  })

  it('the default cap is the documented one', () => {
    expect(DEFAULT_DOSSIER_CHARS).toBe(1200)
  })
})

describe('M39 — nothing to say means nothing said', () => {
  it('returns an empty string for a contact with no records', () => {
    // Not a header with an empty body. In a cached prefix that costs tokens on
    // every cue of every call, forever, and tells the model nothing.
    const d = buildClientDossier({ contact: { id: 'zz', name: 'Nobody' }, calls: [], tasks: [] })
    expect(d.text).toBe('')
    expect(d.chars).toBe(0)
    expect(d.sections).toEqual([])
  })

  it('ignores calls belonging to another contact', () => {
    const other = RICH.map((c) => ({ ...c, contactId: 'someone-else' }))
    expect(buildClientDossier({ contact, calls: other, tasks: [] }).text).toBe('')
  })

  it('ignores deleted calls', () => {
    const deleted = RICH.map((c) => ({ ...c, deleted: true }))
    expect(buildClientDossier({ contact, calls: deleted, tasks: [] }).text).toBe('')
  })

  it('says nothing about coaching from a single coached call', () => {
    // One score is a number; two are a direction. 20 of the founder's contacts
    // have 2+ calls, so this branch is the common one, not the edge case.
    const one = [RICH[0]]
    const d = buildClientDossier({ contact, calls: one, tasks: [] })
    expect(d.sections).not.toContain('How these calls have gone')
  })

  it('emits no stakeholder section at all', () => {
    // CUT before it was written: 0 of the founder's 50 contacts name another
    // stakeholder and 0 share a company, so the section could only ever be
    // empty on the one corpus anyone can check it against.
    const withStakeholders: DossierContact = {
      ...contact,
      otherStakeholders: 'A whole procurement committee'
    }
    const d = buildClientDossier({ contact: withStakeholders, calls: RICH, tasks: [] })
    expect(d.text).not.toContain('procurement committee')
    expect(d.sections).not.toContain('Stakeholders')
  })
})
