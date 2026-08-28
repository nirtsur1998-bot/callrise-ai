// BUG-096 fix C (2026-08-25) — in an UNBOUND chat, a question naming a client
// must be answered with "I can't reach that here", not confidently from
// rep/business memories.
//
// The bug this guards was never the missing recall. Empty answers stayed
// 0/13: client questions came back with GENERIC business memories and Rise
// answered from them. A confidently wrong answer about a named client is
// worse than a miss, and it is indistinguishable from a correct one to the
// person reading it.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const data = vi.hoisted(() => ({
  contacts: [] as Record<string, unknown>[],
  memoriesByScope: new Map<string, unknown[]>(),
  brainOn: true,
  db: {} as unknown
}))

vi.mock('../../contacts-fs', () => ({ listContacts: async () => data.contacts }))
vi.mock('../../app-settings', () => ({ isSalesBrainEnabled: () => data.brainOn }))
vi.mock('../../memory/memory-runtime', () => ({ getMemoryDb: () => data.db }))
vi.mock('../../memory/memories-store', () => ({
  listMemories: (_db: unknown, opts: { scope?: string }) =>
    data.memoriesByScope.get(opts.scope ?? '') ?? []
}))

const { detectUnboundClientMentions, unboundClientNotice } = await import('../unbound-client')

const CONTACTS_DIR = 'contacts'

beforeEach(() => {
  data.brainOn = true
  data.db = {}
  data.contacts = [
    { id: 'acme', name: 'Dana Levy', company: 'Acme' },
    { id: 'globex', name: 'Sam Park', company: 'Globex' },
    { id: 'art', name: 'Art Vandelay', company: 'Vandelay Industries' }
  ]
  data.memoriesByScope = new Map([
    ['client:acme', [{ id: 'm1' }, { id: 'm2' }]],
    ['client:globex', []]
  ])
})

describe('detectUnboundClientMentions', () => {
  it('matches a company name and reports how many memories exist', async () => {
    const out = await detectUnboundClientMentions('who decides at Acme?', CONTACTS_DIR)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ contactId: 'acme', memoryCount: 2 })
  })

  it('matches a person by name', async () => {
    const out = await detectUnboundClientMentions('what did Sam Park say?', CONTACTS_DIR)
    expect(out.map((m) => m.contactId)).toEqual(['globex'])
  })

  it('reports zero when the client exists but has no memories', async () => {
    const out = await detectUnboundClientMentions('remind me about Globex', CONTACTS_DIR)
    expect(out[0].memoryCount).toBe(0)
  })

  it('matches on WHOLE WORDS only — "Art" must not fire inside "start"', async () => {
    // Substring matching would put a spurious notice in front of the model on
    // ordinary questions, which is worse than the silence it replaces.
    const out = await detectUnboundClientMentions('how do I start a discovery call?', CONTACTS_DIR)
    expect(out).toHaveLength(0)
  })

  it('no match on a question that names nobody', async () => {
    expect(await detectUnboundClientMentions('how do I handle pricing pushback?', CONTACTS_DIR)).toEqual([])
  })

  it('with Sales Brain off it still names the client, and claims no counts', async () => {
    data.brainOn = false
    const out = await detectUnboundClientMentions('who decides at Acme?', CONTACTS_DIR)
    expect(out).toHaveLength(1)
    expect(out[0].memoryCount).toBe(0)
  })
})

describe('unboundClientNotice', () => {
  it('is null when nothing was named — no notice on ordinary turns', () => {
    expect(unboundClientNotice([])).toBeNull()
  })

  it('DISTINGUISHES "exists but unreachable" from "nothing learned yet"', () => {
    // The founder's requirement: the two suggest different user actions, so
    // collapsing both into "I don't know" is the thing to avoid.
    const notice = unboundClientNotice([
      { contactId: 'acme', label: 'Dana Levy (Acme)', memoryCount: 2 },
      { contactId: 'globex', label: 'Sam Park (Globex)', memoryCount: 0 }
    ])
    const text = notice!.lines.map((l) => l.text).join('\n')
    expect(text).toContain('2 memories exist for this client, but they are NOT reachable')
    expect(text).toContain('no memories have been learned about this client yet')
    expect(text).toContain('scoped to that')
  })

  it('tells the model NOT to answer from rep/business context', () => {
    const notice = unboundClientNotice([
      { contactId: 'acme', label: 'Acme', memoryCount: 1 }
    ])
    const text = notice!.lines.map((l) => l.text).join('\n')
    expect(text).toContain('Do NOT present rep-wide or business-wide facts')
  })

  it('singular/plural reads correctly for one memory', () => {
    const notice = unboundClientNotice([{ contactId: 'acme', label: 'Acme', memoryCount: 1 }])
    expect(notice!.lines[0].text).toContain('1 memory exist')
  })
})
