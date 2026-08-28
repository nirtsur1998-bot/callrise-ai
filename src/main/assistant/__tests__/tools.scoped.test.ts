// M28 Part 4 — the cross-client invariant at the LOOKUP layer: in a scoped
// conversation, every record lookup is filtered to one contact by the data,
// not by the model's discipline. Plus the standing client brief.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const data = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  fullCalls: new Map<string, Record<string, unknown>>(),
  contacts: [] as Record<string, unknown>[],
  deals: [] as Record<string, unknown>[],
  // AUDIT FIX (2026-08-24) — these three were hard-stubbed to [] , so
  // today_schedule could never be exercised here and the one branch of
  // executeLookups that DROPPED the client scope had no coverage at all.
  events: [] as Record<string, unknown>[],
  googleEvents: [] as Record<string, unknown>[],
  outlookEvents: [] as Record<string, unknown>[]
}))

vi.mock('../../ai/complete-with-fallback', () => ({
  completeWithFallback: async () => ({ toolInput: { lookups: [] } })
}))
vi.mock('../../calls-fs', () => ({
  listCalls: async () => data.calls,
  getCall: async (_d: string, id: string) => data.fullCalls.get(id) ?? null
}))
vi.mock('../../contacts-fs', () => ({ listContacts: async () => data.contacts }))
vi.mock('../../deals-fs', () => ({ listDeals: async () => data.deals }))
vi.mock('../../events-fs', () => ({ listEvents: async () => data.events }))
vi.mock('../../google', () => ({ getCachedGoogleEvents: async () => data.googleEvents }))
vi.mock('../../outlook', () => ({ getCachedOutlookEvents: async () => data.outlookEvents }))

import { clientBriefSections, executeLookups } from '../tools'

const DIRS = { callsDir: 'c', contactsDir: 'k', dealsDir: 'd', eventsDir: 'e' }

beforeEach(() => {
  data.contacts = [
    { id: 'acme', name: 'Dana Levy', company: 'Acme' },
    { id: 'globex', name: 'Sam Park', company: 'Globex' }
  ]
  data.deals = [
    { id: 'd-acme', title: 'Acme expansion', contactId: 'acme', stageId: 's', value: 40000, createdAt: 'x', updatedAt: 'x' },
    { id: 'd-globex', title: 'Globex pilot', contactId: 'globex', stageId: 's', value: 9000, createdAt: 'x', updatedAt: 'x' }
  ]
  data.calls = [
    { id: 'call-acme', title: 'Acme pricing call', preview: 'budget and pilot', contactId: 'acme', createdAt: '2026-08-01T10:00:00Z' },
    { id: 'call-globex', title: 'Globex pilot call', preview: 'budget and pilot', contactId: 'globex', createdAt: '2026-08-02T10:00:00Z' }
  ]
  data.fullCalls = new Map()
  const today = new Date()
  const at = (h: number): string =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, 0, 0).toISOString()
  data.events = [
    { id: 'e-acme', title: 'Acme roadmap review', start: at(9), allDay: false, contactId: 'acme' },
    { id: 'e-globex', title: 'Globex pilot review with Sam Park', start: at(14), allDay: false, contactId: 'globex' },
    { id: 'e-none', title: 'Northwind renewal', start: at(16), allDay: false }
  ]
  data.googleEvents = [
    { externalId: 'g-1', title: 'Umbrella Corp QBR', start: at(11), allDay: false }
  ]
  data.outlookEvents = [
    { externalId: 'o-1', title: 'Initech contract signing', start: at(15), allDay: false }
  ]
})

describe('scoped lookups never surface another client (red-check target)', () => {
  it('search_calls: a query matching BOTH clients returns only the scoped one', async () => {
    const { sections } = await executeLookups(
      [{ kind: 'search_calls', query: 'budget pilot' }],
      DIRS,
      undefined,
      'acme'
    )
    const texts = sections[0].lines.map((l) => l.text)
    expect(texts.some((t) => t.includes('Acme pricing call'))).toBe(true)
    expect(texts.some((t) => t.includes('Globex'))).toBe(false)
  })

  it('find_contact: asking about ANOTHER name still yields only the scoped record', async () => {
    const { sections } = await executeLookups(
      [{ kind: 'find_contact', query: 'Sam Park at Globex' }],
      DIRS,
      undefined,
      'acme'
    )
    const text = sections[0].lines.map((l) => l.text).join('\n')
    expect(text).toContain('Dana Levy')
    expect(text).not.toContain('Sam Park')
  })

  it('find_deal: the other client\'s deal is invisible even when it matches better', async () => {
    const { sections } = await executeLookups(
      [{ kind: 'find_deal', query: 'Globex pilot' }],
      DIRS,
      undefined,
      'acme'
    )
    const text = sections[0].lines.map((l) => l.text).join('\n')
    expect(text).not.toContain('Globex pilot')
  })

  it('unscoped (global) lookups still see everything — the filter is scope-only', async () => {
    const { sections } = await executeLookups(
      [{ kind: 'search_calls', query: 'budget pilot' }],
      DIRS
    )
    const texts = sections[0].lines.map((l) => l.text).join('\n')
    expect(texts).toContain('Acme pricing call')
    expect(texts).toContain('Globex pilot call')
  })
})

describe('clientBriefSections', () => {
  it('assembles record + deals + recent calls (citable), only for that client', async () => {
    const sections = await clientBriefSections('acme', DIRS)
    expect(sections.map((s) => s.title)).toEqual([
      'THIS CLIENT — CONTACT RECORD',
      'THIS CLIENT — DEALS',
      'THIS CLIENT — RECENT CALLS (newest first)'
    ])
    expect(sections[0].lines[0].text).toContain('Dana Levy')
    expect(sections[1].lines[0].text).toContain('Acme expansion')
    expect(sections[1].lines.map((l) => l.text).join()).not.toContain('Globex')
    expect(sections[2].lines[0].cite).toEqual({ kind: 'call', id: 'call-acme', label: 'Acme pricing call' })
    expect(sections[2].lines.map((l) => l.text).join()).not.toContain('Globex')
  })

  it('an unknown contact yields no sections (nothing to lead with)', async () => {
    expect(await clientBriefSections('nobody', DIRS)).toEqual([])
  })
})

// AUDIT FIX (2026-08-24) — the cross-client CALENDAR leak.
//
// executeLookups threaded scopeContactId into search_calls, find_contact and
// find_deal, and dropped it on this one branch. A client-scoped turn therefore
// injected the whole day's calendar — every other client's meeting titles —
// under a system prompt that says verbatim "The CONTEXT below contains ONLY
// this client's records", and under a UI badge that promises Rise "never mixes
// in another client".
//
// The old test file stubbed all three event sources to [] permanently, so the
// leak was not merely untested: it was untestable here.
describe('today_schedule in a scoped conversation — the cross-client invariant', () => {
  const runSchedule = (scopeContactId?: string) =>
    executeLookups([{ kind: 'today_schedule', query: '' }], DIRS, undefined, scopeContactId)

  it('UNSCOPED: the full day is shown, every source merged (unchanged behaviour)', async () => {
    const { sections } = await runSchedule()
    const text = sections[0].lines.map((l) => l.text).join('\n')
    expect(text).toContain('Acme roadmap review')
    expect(text).toContain('Globex pilot review with Sam Park')
    expect(text).toContain('Northwind renewal')
    expect(text).toContain('Umbrella Corp QBR')
    expect(text).toContain('Initech contract signing')
  })

  it("SCOPED: another client's meeting never reaches the prompt", async () => {
    const { sections } = await runSchedule('acme')
    const text = sections[0].lines.map((l) => l.text).join('\n')

    expect(text).toContain('Acme roadmap review')
    for (const leaked of [
      'Globex pilot review with Sam Park',
      'Northwind renewal',
      'Umbrella Corp QBR',
      'Initech contract signing'
    ]) {
      expect(
        text,
        `"${leaked}" reached a chat scoped to a different client — the prompt asserts the context holds ONLY this client's records`
      ).not.toContain(leaked)
    }
  })

  it('SCOPED: provider-calendar events are dropped wholesale, not filtered', async () => {
    // GoogleEvent and its Outlook counterpart have no contactId field at all
    // (only local events-fs events do), so there is no filter that keeps them
    // safely — including any of them IS the leak. An unlinked LOCAL event is
    // excluded for the same reason.
    data.events = [{ id: 'e-x', title: 'Unlinked local meeting', start: new Date().toISOString(), allDay: false }]
    const { sections } = await runSchedule('acme')
    const text = sections[0].lines.map((l) => l.text).join('\n')
    expect(text).not.toContain('Unlinked local meeting')
    expect(text).not.toContain('Umbrella Corp QBR')
  })

  it('SCOPED: says what it is hiding, so the model cannot claim an empty day', async () => {
    // Filtering to nothing and emitting the unscoped "Nothing on the calendar
    // today." would be a confident falsehood that could cost the user a
    // meeting — a different failure, not a fix.
    data.events = []
    const { sections } = await runSchedule('acme')
    const text = sections[0].lines.map((l) => l.text).join('\n')
    expect(sections[0].title).toContain('this client only')
    expect(text).not.toContain('Nothing on the calendar today.')
    expect(text).toContain('do not tell the user their day is empty')
  })
})

// AUDIT FIX (2026-08-24) — the scoped find_contact LABEL.
//
// The record returned was correctly scoped all along; the section TITLE was
// the leak. The scoped branch discards the query and returns this
// conversation's client regardless, while the title interpolated the query —
// so the system prompt asserted that client A's private record was the answer
// to a question about person B, right next to SCOPE_RULE's instruction to
// "treat every question as being about them".
describe('find_contact in a scoped conversation — the label must not lie', () => {
  const run = (query: string, scopeContactId?: string) =>
    executeLookups([{ kind: 'find_contact', query }], DIRS, undefined, scopeContactId)

  it("does NOT claim the scoped client's record matched another person's name", async () => {
    const { sections } = await run('Sam Park at Globex', 'acme')
    expect(
      sections[0].title,
      "the prompt labelled Dana Levy's record as matching Sam Park's name"
    ).not.toContain('Sam Park')
    expect(sections[0].title).toContain("THIS CONVERSATION'S CLIENT")
  })

  it('says plainly that the other name was not looked up', async () => {
    const { sections } = await run('Sam Park at Globex', 'acme')
    const text = sections[0].lines.map((l) => l.text).join('\n')
    expect(text).toContain('Dana Levy')
    expect(text).toContain('was NOT looked up')
    expect(text).toContain('Do not present this record as a match for another name')
    // The clarifier must not reintroduce the other person's name — the file's
    // standing invariant is that no other name appears in a scoped section.
    expect(text).not.toContain('Sam Park')
  })

  it('UNSCOPED: the query-matching title is unchanged', async () => {
    const { sections } = await run('Sam Park', undefined)
    expect(sections[0].title).toBe('CONTACT RECORDS MATCHING "Sam Park"')
    const text = sections[0].lines.map((l) => l.text).join('\n')
    expect(text).toContain('Sam Park')
    expect(text).not.toContain('was NOT looked up')
  })
})
