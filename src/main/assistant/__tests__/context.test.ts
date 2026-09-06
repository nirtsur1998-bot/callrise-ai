// M28 — context assembly + citation parsing (pure, no mocks needed).
import { describe, expect, it } from 'vitest'
import { buildAssistantContext, citationsUsedIn } from '../context'
import type { Memory } from '../../memory/types'

function mem(id: string, statement: string, status: Memory['status'] = 'active'): Memory {
  return {
    id,
    scope: 'rep',
    category: 'selling-pattern',
    statement,
    evidence: [],
    confidence: 0.7,
    importance: 5,
    status,
    source: 'auto',
    pinned: false,
    createdAt: '2026-01-01T00:00:00Z',
    lastConfirmedAt: '2026-01-01T00:00:00Z'
  } as Memory
}

describe('buildAssistantContext', () => {
  it('numbers retrieved memories and maps markers to citations in order', () => {
    const ctx = buildAssistantContext({
      repProfile: '--- REP ---\n- fact',
      businessProfile: '',
      retrieved: [
        { memory: mem('m-a', 'Discovery calls run long'), distance: 0.1 },
        { memory: mem('m-b', 'Acme prefers email'), distance: 0.2 }
      ]
    })
    expect(ctx.system).toContain('[1] Discovery calls run long')
    expect(ctx.system).toContain('[2] Acme prefers email')
    expect(ctx.citationsByMarker.get(1)).toEqual({
      kind: 'memory',
      id: 'm-a',
      label: 'Discovery calls run long',
      marker: 1
    })
    expect(ctx.citationsByMarker.get(2)?.id).toBe('m-b')
    // Profiles included, empty ones omitted.
    expect(ctx.system).toContain('--- REP ---')
  })

  // M36 Stage 3 item 5, step 5 — the validity window on the citation line,
  // and the temporal rule only when a closed window is present.
  it('an undated memory renders exactly as before — no window, no temporal rule', () => {
    const ctx = buildAssistantContext({
      repProfile: '',
      businessProfile: '',
      retrieved: [{ memory: mem('m-a', 'Solid fact'), distance: 0.1 }]
    })
    expect(ctx.system).toContain('[1] Solid fact (confidence: 70%)')
    expect(ctx.system).not.toContain('TEMPORAL RULE')
  })

  it('a dated live fact says since when; a superseded one says its window, and the temporal rule follows', () => {
    const live = { ...mem('m-live', 'Budget is 55k'), validFrom: '2026-07-02T15:30:00.000Z', validFromSource: 'call' as const }
    const old = {
      ...mem('m-old', 'Budget is 40k', 'invalidated'),
      validFrom: '2026-03-14T10:00:00.000Z',
      validFromSource: 'call' as const,
      validUntil: '2026-07-02T15:30:00.000Z',
      validUntilSource: 'call' as const
    }
    const liveOnly = buildAssistantContext({ repProfile: '', businessProfile: '', retrieved: [{ memory: live, distance: 0.1 }] })
    expect(liveOnly.system).toContain('[1] Budget is 55k (true since 2026-07-02) (confidence: 70%)')
    expect(liveOnly.system).not.toContain('TEMPORAL RULE')

    const asOf = buildAssistantContext({ repProfile: '', businessProfile: '', retrieved: [{ memory: old, distance: 0.1 }] })
    expect(asOf.system).toContain('[1] Budget is 40k (true from 2026-03-14 until 2026-07-02, then superseded) (confidence: 70%)')
    expect(asOf.system).toContain('TEMPORAL RULE')
    expect(asOf.system).toContain('not true now')
  })

  it('an approximate date reads "around", never a precise day', () => {
    const approx = { ...mem('m-x', 'Wants a pilot'), validFrom: '2026-05-12T10:00:00.000Z', validFromSource: 'approx' as const }
    const ctx = buildAssistantContext({ repProfile: '', businessProfile: '', retrieved: [{ memory: approx, distance: 0.1 }] })
    expect(ctx.system).toContain('Wants a pilot (true since around 2026-05-12)')
  })

  it('flags hypotheses inline and appends the hedge rule only when needed', () => {
    const withHyp = buildAssistantContext({
      repProfile: '',
      businessProfile: '',
      retrieved: [{ memory: mem('m-h', 'Maybe budget-sensitive', 'hypothesis'), distance: 0.1 }]
    })
    expect(withHyp.system).toContain('Maybe budget-sensitive (still unconfirmed)')
    expect(withHyp.system).toContain('working hypotheses')

    const activeOnly = buildAssistantContext({
      repProfile: '',
      businessProfile: '',
      retrieved: [{ memory: mem('m-a', 'Solid fact'), distance: 0.1 }]
    })
    expect(activeOnly.system).not.toContain('working hypotheses')
  })

  it('with nothing retrieved there is no CONTEXT memories section at all', () => {
    const ctx = buildAssistantContext({ repProfile: '', businessProfile: '', retrieved: [] })
    expect(ctx.system).not.toContain('MEMORIES RELEVANT')
    expect(ctx.citationsByMarker.size).toBe(0)
  })
})

describe('citationsUsedIn', () => {
  const markers = new Map([
    [1, { kind: 'memory' as const, id: 'm-1', label: 'one' }],
    [2, { kind: 'memory' as const, id: 'm-2', label: 'two' }]
  ])

  it('returns cited entries in first-use order, deduped', () => {
    const used = citationsUsedIn('Claim [2]. Another [1], again [2].', markers)
    expect(used.map((c) => c.id)).toEqual(['m-2', 'm-1'])
  })

  it('ignores markers the CONTEXT never defined (model inventions)', () => {
    const used = citationsUsedIn('Fake [7] but real [1].', markers)
    expect(used.map((c) => c.id)).toEqual(['m-1'])
  })

  it('no markers → no citations', () => {
    expect(citationsUsedIn('Plain reply.', markers)).toEqual([])
  })
})
