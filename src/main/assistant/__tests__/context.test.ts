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
      label: 'Discovery calls run long'
    })
    expect(ctx.citationsByMarker.get(2)?.id).toBe('m-b')
    // Profiles included, empty ones omitted.
    expect(ctx.system).toContain('--- REP ---')
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
