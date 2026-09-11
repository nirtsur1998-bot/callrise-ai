// M39 Stage 4 #5 — "what changed since last call", and the two bugs its first
// run produced.
//
// 1. THE SECTION RENDERED TO NOTHING. `render` iterates a fixed `ORDER` list,
//    not the items, so a section missing from that list is dropped silently:
//    the lines were built, ranked above most of the dossier, survived the cap,
//    and never appeared. Measured 0 of 50 against a population of 6. The only
//    reason it was caught is that the zero was checked against the population
//    instead of read as "there was nothing to say" — species 117, in the shape
//    that costs a feature rather than a number.
//
// 2. AN EMPTY DOSSIER THAT WASN'T EMPTY. The emptiness check counted ITEMS, so
//    with the section unlisted a contact whose only content was a dropped
//    section came back as the bare string "CLIENT: Foo" — a name, a heading,
//    and nothing to know, handed to the model as context. Coverage read 30 of
//    50 instead of 29, which is how it surfaced.
//
// Both are now pinned below rather than fixed and forgotten.
import { describe, expect, it } from 'vitest'
import { buildClientDossier, type DossierInput } from '../clientDossier'

const ASOF = '2026-09-11T00:00:00.000Z'
const call = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
  id,
  contactId: 'c1',
  createdAt,
  ...over
})

const base = (over: Partial<DossierInput> = {}): DossierInput => ({
  contact: { id: 'c1', name: 'Harvey' },
  deal: null,
  stageLabel: null,
  calls: [call('call-2', '2026-09-05T10:00:00.000Z'), call('call-1', '2026-09-01T10:00:00.000Z')],
  tasks: [],
  objections: [],
  asOf: ASOF,
  ...over
})

const text = (input: DossierInput): string => buildClientDossier(input).text

describe('M39 — the section actually reaches the rendered dossier', () => {
  it('renders the heading and the line, not just the item', () => {
    const out = text(
      base({
        deal: {
          id: 'd1',
          contactId: 'c1',
          title: 'Harvey',
          stageId: 'proposal',
          stageHistory: [{ stageId: 'proposal', changedAt: '2026-09-03T00:00:00.000Z' }]
        },
        stageLabel: 'Proposal'
      })
    )
    // This is the assertion the first version would have failed: the section
    // existed as an Item and was thrown away at render.
    expect(out).toContain('Since your last call with them:')
    expect(out).toContain('The deal moved to Proposal.')
  })

  it('every section a dossier can emit is present in the render ORDER', () => {
    // The general form of bug 1. Build a dossier with every signal switched on
    // and assert that each section the builder REPORTS is also a heading in the
    // text — a section can only be reported if ORDER rendered it, so a new
    // unlisted section shows up as a line that exists nowhere.
    const full = base({
      contact: { id: 'c1', name: 'Harvey', company: 'Acme' },
      deal: {
        id: 'd1',
        contactId: 'c1',
        title: 'Harvey',
        stageId: 'won',
        stageHistory: [{ stageId: 'negotiating', changedAt: '2026-09-03T00:00:00.000Z' }]
      },
      stageLabel: 'Won',
      calls: [
        call('call-2', '2026-09-05T10:00:00.000Z', {
          summary: { executive: 'They asked for a discount.' },
          coaching: {
            overallScore: 60,
            nextAction: 'Send the revised quote',
            dimensions: [
              {
                key: 'objections',
                comment: 'handled well',
                evidence: { verified: true, quote: 'Too expensive' }
              }
            ]
          }
        }),
        call('call-1', '2026-09-01T10:00:00.000Z', {
          coaching: { overallScore: 50, dimensions: [{ key: 'objections', comment: 'missed it' }] }
        })
      ],
      tasks: [
        {
          id: 't1',
          contactId: 'c1',
          title: 'Send the deck',
          completedAt: '2026-09-04T00:00:00.000Z'
        },
        { id: 't2', contactId: 'c1', title: 'Call the bank', dueAt: '2026-09-02' }
      ],
      objections: [
        { callId: 'call-1', type: 'price', contactId: 'c1' },
        { callId: 'call-2', type: 'timing', contactId: 'c1' }
      ] as DossierInput['objections']
    })
    const built = buildClientDossier(full)
    expect(built.sections.length).toBeGreaterThan(3)
    for (const section of built.sections) {
      expect(built.text, `section "${section}" was reported but never rendered`).toContain(
        `${section}:`
      )
    }
  })

  it('a dossier with no rendered section is EMPTY, not a bare CLIENT line', () => {
    // Bug 2. A contact with nothing to say must get '' so the prompt is
    // byte-for-byte the pre-M39 prompt — not a heading with a name under it.
    const out = buildClientDossier(base({ calls: [], tasks: [], objections: [] }))
    expect(out.text).toBe('')
    expect(out.chars).toBe(0)
  })
})

describe('M39 — what counts as changed', () => {
  const withDeal = (
    stageId: string,
    history: { stageId: string; changedAt: string }[],
    label: string | null
  ) =>
    base({
      deal: { id: 'd1', contactId: 'c1', title: 'Harvey', stageId, stageHistory: history },
      stageLabel: label
    })

  it('names the stage only when the history landed where the deal now is', () => {
    const out = text(
      withDeal(
        'proposal',
        [{ stageId: 'proposal', changedAt: '2026-09-03T00:00:00.000Z' }],
        'Proposal'
      )
    )
    expect(out).toContain('The deal moved to Proposal.')
  })

  it('does not claim a destination the history does not support', () => {
    // The deal moved again after its last recorded transition — true of 2 of
    // the founder's 13 deals. Saying "moved to Won" would assert a timing the
    // records do not carry; saying nothing would drop a real signal.
    const out = text(
      withDeal('won', [{ stageId: 'negotiating', changedAt: '2026-09-03T00:00:00.000Z' }], 'Won')
    )
    expect(out).toContain('The deal has moved since — it is at Won now.')
    expect(out).not.toContain('moved to Won')
  })

  it('never renders a raw stage id', () => {
    const out = text(
      withDeal(
        '404325fd-6b90-4daf-a4e2-d9b06ff1a2bc',
        [
          { stageId: '404325fd-6b90-4daf-a4e2-d9b06ff1a2bc', changedAt: '2026-09-03T00:00:00.000Z' }
        ],
        null
      )
    )
    expect(out).toContain('The deal moved to a new stage.')
    expect(out).not.toContain('404325fd')
  })

  it('ignores a transition from BEFORE the previous call', () => {
    const out = text(
      withDeal(
        'proposal',
        [{ stageId: 'proposal', changedAt: '2026-08-01T00:00:00.000Z' }],
        'Proposal'
      )
    )
    expect(out).not.toContain('Since your last call with them')
  })

  it('counts a task completed after the previous call, and says how many more', () => {
    const out = text(
      base({
        tasks: [
          {
            id: 't1',
            contactId: 'c1',
            title: 'Send the deck',
            completedAt: '2026-09-04T00:00:00.000Z'
          },
          {
            id: 't2',
            contactId: 'c1',
            title: 'Call the bank',
            completedAt: '2026-09-06T00:00:00.000Z'
          }
        ]
      })
    )
    expect(out).toContain('You have since done: Send the deck (and 1 more).')
  })

  it('finds a completed task through its CALL when it carries no contactId', () => {
    // Only 11 of the founder's 28 tasks carry a contactId, so the call-linked
    // fallback is not a nicety — without it this signal loses most of its
    // population.
    const out = text(
      base({
        tasks: [
          {
            id: 't1',
            callId: 'call-2',
            title: 'Send the deck',
            completedAt: '2026-09-06T00:00:00.000Z'
          }
        ]
      })
    )
    expect(out).toContain('You have since done: Send the deck.')
  })

  it('ignores a task completed BEFORE the previous call', () => {
    const out = text(
      base({
        tasks: [
          { id: 't1', contactId: 'c1', title: 'Old thing', completedAt: '2026-08-20T00:00:00.000Z' }
        ]
      })
    )
    expect(out).not.toContain('You have since done')
  })

  it('reports a shift in what they push back on', () => {
    const out = text(
      base({
        objections: [
          { callId: 'call-1', type: 'trust' },
          { callId: 'call-2', type: 'approval' }
        ] as DossierInput['objections']
      })
    )
    expect(out).toContain('Their pushback shifted from trust to approval.')
  })

  it('says nothing when the pushback did not shift', () => {
    const out = text(
      base({
        objections: [
          { callId: 'call-1', type: 'trust' },
          { callId: 'call-2', type: 'trust' }
        ] as DossierInput['objections']
      })
    )
    expect(out).not.toContain('pushback shifted')
  })

  it('ignores unclassified objection types rather than reporting "other"', () => {
    // 108 of the founder's 287 mined objections are typed `other`. "Their
    // pushback shifted from other to trust" is noise wearing a fact's clothes.
    const out = text(
      base({
        objections: [
          { callId: 'call-1', type: 'other' },
          { callId: 'call-2', type: 'trust' }
        ] as DossierInput['objections']
      })
    )
    expect(out).not.toContain('pushback shifted')
  })

  it('says nothing at all on a first call', () => {
    const out = text(base({ calls: [call('call-1', '2026-09-05T10:00:00.000Z')] }))
    expect(out).not.toContain('Since your last call with them')
  })

  it('is byte-identical across two assemblies', () => {
    // The dossier is a cached prompt prefix. A Map iteration, a locale format
    // or a sort by a field a background job rewrites would cost every cue.
    const input = base({
      deal: {
        id: 'd1',
        contactId: 'c1',
        title: 'Harvey',
        stageId: 'won',
        stageHistory: [{ stageId: 'negotiating', changedAt: '2026-09-03T00:00:00.000Z' }]
      },
      stageLabel: 'Won',
      tasks: [
        { id: 't2', contactId: 'c1', title: 'B', completedAt: '2026-09-04T00:00:00.000Z' },
        { id: 't1', contactId: 'c1', title: 'A', completedAt: '2026-09-06T00:00:00.000Z' }
      ]
    })
    expect(text(input)).toBe(text(input))
  })
})
