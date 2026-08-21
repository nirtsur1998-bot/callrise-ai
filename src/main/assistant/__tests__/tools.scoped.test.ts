// M28 Part 4 — the cross-client invariant at the LOOKUP layer: in a scoped
// conversation, every record lookup is filtered to one contact by the data,
// not by the model's discipline. Plus the standing client brief.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const data = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  fullCalls: new Map<string, Record<string, unknown>>(),
  contacts: [] as Record<string, unknown>[],
  deals: [] as Record<string, unknown>[]
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
vi.mock('../../events-fs', () => ({ listEvents: async () => [] }))
vi.mock('../../google', () => ({ getCachedGoogleEvents: async () => [] }))
vi.mock('../../outlook', () => ({ getCachedOutlookEvents: async () => [] }))

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
