// M28 — the tool dispatcher. Data modules are stubbed with fixtures; what
// this file proves is the NEW logic: plan validation (a hostile/malformed
// model output can only ever produce allowlisted lookups), scoring/format
// of each lookup, schedule dedupe across local + provider caches, honest
// degradation (plan failure → no lookups, one lookup failing → others
// survive), and that propose_task generates a proposal without writing.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const ai = vi.hoisted(() => ({
  complete: vi.fn(async (_req: Record<string, unknown>): Promise<{ toolInput: unknown }> => ({
    toolInput: { lookups: [] }
  }))
}))
const data = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  fullCalls: new Map<string, Record<string, unknown>>(),
  contacts: [] as Record<string, unknown>[],
  deals: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  google: [] as Record<string, unknown>[],
  outlook: [] as Record<string, unknown>[]
}))

vi.mock('../../ai/complete-with-fallback', () => ({ completeWithFallback: ai.complete }))
vi.mock('../../calls-fs', () => ({
  listCalls: async () => data.calls,
  getCall: async (_d: string, id: string) => data.fullCalls.get(id) ?? null
}))
vi.mock('../../contacts-fs', () => ({ listContacts: async () => data.contacts }))
vi.mock('../../deals-fs', () => ({ listDeals: async () => data.deals }))
vi.mock('../../events-fs', () => ({ listEvents: async () => data.events }))
vi.mock('../../google', () => ({ getCachedGoogleEvents: async () => data.google }))
vi.mock('../../outlook', () => ({ getCachedOutlookEvents: async () => data.outlook }))

import { executeLookups, planLookups } from '../tools'

const DIRS = { callsDir: 'c', contactsDir: 'k', dealsDir: 'd', eventsDir: 'e' }
const todayIso = (h: number): string => {
  const d = new Date()
  d.setHours(h, 0, 0, 0)
  return d.toISOString()
}

beforeEach(() => {
  ai.complete.mockReset()
  ai.complete.mockResolvedValue({ toolInput: { lookups: [] } })
  data.calls = []
  data.fullCalls = new Map()
  data.contacts = []
  data.deals = []
  data.events = []
  data.google = []
  data.outlook = []
})

describe('planLookups', () => {
  it('keeps only allowlisted kinds and clamps queries', async () => {
    ai.complete.mockResolvedValueOnce({
      toolInput: {
        lookups: [
          { kind: 'search_calls', query: 'x'.repeat(500) },
          { kind: 'delete_everything', query: 'rm -rf' },
          { kind: 'today_schedule' },
          'garbage'
        ]
      }
    })
    const planned = await planLookups('question')
    expect(planned.map((p) => p.kind)).toEqual(['search_calls', 'today_schedule'])
    expect(planned[0].query).toHaveLength(200)
  })

  it('any AI failure degrades to no lookups, never a throw', async () => {
    ai.complete.mockRejectedValueOnce(new Error('no tool-capable model'))
    expect(await planLookups('question')).toEqual([])
  })
})

describe('executeLookups — search_calls', () => {
  it('scores title+preview, pulls the executive summary, and makes results citable', async () => {
    data.calls = [
      { id: 'call-1', title: 'Acme pricing call', preview: 'budget talk', createdAt: '2026-08-01T10:00:00Z' },
      { id: 'call-2', title: 'Unrelated demo', preview: 'nothing here', createdAt: '2026-08-02T10:00:00Z' }
    ]
    data.fullCalls.set('call-1', { summary: { executive: 'They pushed on price; timeline Q4.' } })
    const { sections } = await executeLookups(
      [{ kind: 'search_calls', query: 'acme pricing' }],
      DIRS
    )
    expect(sections).toHaveLength(1)
    expect(sections[0].lines).toHaveLength(1)
    expect(sections[0].lines[0].text).toContain('Acme pricing call')
    expect(sections[0].lines[0].text).toContain('They pushed on price')
    expect(sections[0].lines[0].cite).toEqual({ kind: 'call', id: 'call-1', label: 'Acme pricing call' })
  })

  it('no matches still yields an honest section (the model sees "none found")', async () => {
    const { sections } = await executeLookups([{ kind: 'search_calls', query: 'zzz' }], DIRS)
    expect(sections[0].lines[0].text).toBe('No matching calls found.')
  })
})

describe('executeLookups — contacts and deals', () => {
  it('find_contact joins the contact card with their deals', async () => {
    data.contacts = [
      { id: 'c-1', name: 'Dana Levy', company: 'Acme', title: 'VP Ops', pipelineStage: 'negotiation' }
    ]
    data.deals = [{ id: 'd-1', title: 'Acme expansion', contactId: 'c-1', stageId: 's', value: 40000, createdAt: 'x', updatedAt: 'x' }]
    const { sections } = await executeLookups([{ kind: 'find_contact', query: 'dana' }], DIRS)
    expect(sections[0].lines[0].text).toContain('Dana Levy')
    expect(sections[0].lines[0].text).toContain('Acme expansion')
  })

  it('find_deal resolves the owning contact', async () => {
    data.deals = [{ id: 'd-1', title: 'Acme expansion', contactId: 'c-1', stageId: 's', value: 40000, createdAt: 'x', updatedAt: 'x' }]
    data.contacts = [{ id: 'c-1', name: 'Dana Levy' }]
    const { sections } = await executeLookups([{ kind: 'find_deal', query: 'acme expansion' }], DIRS)
    expect(sections[0].lines[0].text).toContain('contact: Dana Levy')
  })
})

describe('executeLookups — today_schedule', () => {
  it('merges local + both caches, dedupes adopted events by externalId, sorts by time', async () => {
    data.events = [
      { id: 'l1', title: 'Adopted standup', start: todayIso(9), allDay: false, externalId: 'g-1' },
      { id: 'l2', title: 'Local planning', start: todayIso(14), allDay: false }
    ]
    data.google = [
      { id: 'g1', title: 'Adopted standup', start: todayIso(9), allDay: false, externalId: 'g-1' },
      { id: 'g2', title: 'Google-only sync call', start: todayIso(11), allDay: false, externalId: 'g-2' }
    ]
    data.outlook = [
      { id: 'o1', title: 'Yesterday meeting', start: '2020-01-01T10:00:00Z', allDay: false, externalId: 'o-1' }
    ]
    const { sections } = await executeLookups([{ kind: 'today_schedule', query: '' }], DIRS)
    const texts = sections[0].lines.map((l) => l.text)
    expect(texts).toHaveLength(3) // adopted counted once, past event excluded
    expect(texts[0]).toContain('Adopted standup')
    expect(texts[1]).toContain('Google-only sync call')
    expect(texts[2]).toContain('Local planning')
  })
})

describe('executeLookups — propose_task and resilience', () => {
  it('propose_task returns a proposal and writes NOTHING', async () => {
    ai.complete.mockResolvedValueOnce({
      toolInput: { title: 'Send Dana the revised quote', type: 'email', priority: 'high' }
    })
    const { taskProposals, sections } = await executeLookups(
      [{ kind: 'propose_task', query: 'remind me to send dana the quote' }],
      DIRS
    )
    expect(sections).toHaveLength(0)
    expect(taskProposals).toHaveLength(1)
    expect(taskProposals[0].title).toBe('Send Dana the revised quote')
    expect(taskProposals[0].type).toBe('email')
    expect(taskProposals[0].id).toBeTruthy()
  })

  it('invalid enum values fall back to safe defaults; empty title drops the proposal', async () => {
    ai.complete.mockResolvedValueOnce({
      toolInput: { title: 'Do the thing', type: 'hack', priority: 'urgent!!' }
    })
    const first = await executeLookups([{ kind: 'propose_task', query: 'x' }], DIRS)
    expect(first.taskProposals[0].type).toBe('general')
    expect(first.taskProposals[0].priority).toBe('medium')

    ai.complete.mockResolvedValueOnce({ toolInput: { title: '   ' } })
    const second = await executeLookups([{ kind: 'propose_task', query: 'x' }], DIRS)
    expect(second.taskProposals).toHaveLength(0)
  })

  it('one lookup failing never sinks the others', async () => {
    data.contacts = [{ id: 'c-1', name: 'Dana Levy' }]
    ai.complete.mockRejectedValueOnce(new Error('quota'))
    const { sections, taskProposals } = await executeLookups(
      [
        { kind: 'propose_task', query: 'boom' },
        { kind: 'find_contact', query: 'dana' }
      ],
      DIRS
    )
    expect(taskProposals).toHaveLength(0)
    expect(sections).toHaveLength(1)
    expect(sections[0].lines[0].text).toContain('Dana Levy')
  })
})
