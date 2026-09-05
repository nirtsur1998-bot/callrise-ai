// @vitest-environment happy-dom
//
// M34 3d — the hook resolves the deal facts ONCE per matched meeting, from the
// real IPC surface (mocked here), and never refreshes while the meeting stays.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLiveDealFacts } from '../useLiveDealFacts'
import type { LiveDealFacts } from '../dealFacts'
import type { CalendarEvent } from '@renderer/features/calendar/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Consumer({ meeting, onFacts }: { meeting: CalendarEvent | null; onFacts: (f: LiveDealFacts | null) => void }): null {
  onFacts(useLiveDealFacts(meeting))
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

const meeting = (over: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id: 'm1', title: 'Acme sync', start: '2026-09-05T09:00:00.000Z', end: '2026-09-05T09:30:00.000Z', contactId: 'c1', dealId: 'd1', ...over }) as CalendarEvent

describe('useLiveDealFacts', () => {
  let container: HTMLDivElement
  let root: Root
  let api: { calls: { list: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> }; deals: { list: ReturnType<typeof vi.fn> }; dealStages: { get: ReturnType<typeof vi.fn> } }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    api = {
      calls: {
        list: vi.fn(async () => [
          { id: 'old', contactId: 'c1', createdAt: '2026-08-10T09:00:00.000Z' },
          { id: 'new', contactId: 'c1', createdAt: '2026-08-27T09:00:00.000Z' },
          { id: 'other', contactId: 'c2', createdAt: '2026-09-01T09:00:00.000Z' }
        ]),
        get: vi.fn(async (id: string) => (id === 'new' ? { id, coaching: { nextAction: 'Send the pricing comparison' } } : { id }))
      },
      deals: {
        list: vi.fn(async () => [
          { id: 'd1', title: 'Acme', contactId: 'c1', stageId: 'proposal', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
            riskAssessment: { level: 'high', summary: '', reasons: [], suggestedAction: '', model: 't', createdAt: new Date().toISOString() } }
        ])
      },
      dealStages: { get: vi.fn(async () => [{ id: 'proposal', label: 'Proposal', kind: 'open' }]) }
    }
    ;(window as unknown as { api: unknown }).api = api
  })
  afterEach(() => {
    act(() => root?.unmount())
    container.remove()
  })

  const mount = (m: CalendarEvent | null): { facts: () => LiveDealFacts | null; rerender: (m: CalendarEvent | null) => void } => {
    let latest: LiveDealFacts | null = null
    root = createRoot(container)
    const render = (mm: CalendarEvent | null): void => {
      act(() => { root.render(createElement(Consumer, { meeting: mm, onFacts: (f) => (latest = f) })) })
    }
    render(m)
    return { facts: () => latest, rerender: render }
  }

  it('no meeting → null, and nothing is fetched', async () => {
    const h = mount(null)
    await flush()
    expect(h.facts()).toBeNull()
    expect(api.deals.list).not.toHaveBeenCalled()
    expect(api.calls.list).not.toHaveBeenCalled()
  })

  it('a matched meeting resolves stage, risk and the NEWEST call for that contact with its stored next action', async () => {
    const h = mount(meeting())
    await flush()
    expect(h.facts()).toEqual({
      stage: 'Proposal',
      risk: 'high',
      lastCall: { at: '2026-08-27T09:00:00.000Z', nextAction: 'Send the pricing comparison' }
    })
    expect(api.calls.get).toHaveBeenCalledWith('new') // the newest, not the first
    expect(api.calls.get).toHaveBeenCalledTimes(1)
  })

  it('resolves ONCE per meeting — a re-render with the same meeting does not refetch', async () => {
    const h = mount(meeting())
    await flush()
    const before = api.deals.list.mock.calls.length
    h.rerender(meeting({ title: 'renamed but same id' }))
    await flush()
    expect(api.deals.list.mock.calls.length).toBe(before)
  })

  it('a different meeting re-resolves; a meeting with no links clears to null', async () => {
    const h = mount(meeting())
    await flush()
    h.rerender(meeting({ id: 'm2', contactId: undefined, dealId: undefined }))
    await flush()
    expect(h.facts()).toBeNull()
  })

  it('a failed lookup shows nothing rather than a placeholder', async () => {
    api.deals.list.mockRejectedValueOnce(new Error('ipc down'))
    const h = mount(meeting())
    await flush()
    expect(h.facts()).toBeNull()
  })
})
