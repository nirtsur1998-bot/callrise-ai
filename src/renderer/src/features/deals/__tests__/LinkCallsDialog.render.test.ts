// @vitest-environment happy-dom
//
// M34 — the "link coached calls" dialog: the WHOLE set up front with a count,
// one click per deal, one click for all, nothing reorders.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkCallsDialog } from '../LinkCallsDialog'
import type { LinkSuggestions } from '../types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const set = (): LinkSuggestions => ({
  deals: [
    { dealId: 'e', dealTitle: 'Emma deal', contactId: 'c1', contactName: 'emma', stageLabel: 'Won', kind: 'won', coachedCallIds: ['1', '2'] },
    { dealId: 'k', dealTitle: 'Kevin deal', contactId: 'c2', contactName: 'kevin', stageLabel: 'Won', kind: 'won', coachedCallIds: ['3', '4', '5', '6'] }
  ],
  totalCalls: 6
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}
const click = (el: Element | null): void => {
  if (!el) throw new Error('nothing to click')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll('button')] as HTMLButtonElement[]
const byText = (t: RegExp): HTMLButtonElement | null => buttons().find((b) => t.test(b.textContent ?? '')) ?? null

describe('LinkCallsDialog', () => {
  let container: HTMLDivElement
  let root: Root
  let api: { linkSuggestions: ReturnType<typeof vi.fn>; linkCoachedCalls: ReturnType<typeof vi.fn>; linkAllSuggested: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    let current = set()
    api = {
      linkSuggestions: vi.fn(async () => current),
      linkCoachedCalls: vi.fn(async (dealId: string) => {
        const d = current.deals.find((x) => x.dealId === dealId)!
        current = { deals: current.deals.filter((x) => x.dealId !== dealId), totalCalls: current.totalCalls - d.coachedCallIds.length }
        return { ok: true, linked: d.coachedCallIds.length, suggestions: current, state: {} }
      }),
      linkAllSuggested: vi.fn(async () => {
        const n = current.totalCalls
        current = { deals: [], totalCalls: 0 }
        return { ok: true, linked: n, suggestions: current, state: {} }
      })
    }
    ;(window as unknown as { api: unknown }).api = { dealBackfill: api }
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  it('shows the whole set up front with the total, one row per deal with its own count', async () => {
    act(() => {
      root.render(createElement(LinkCallsDialog, { onClose: vi.fn() }))
    })
    await flush()
    expect(document.querySelector('[data-testid="link-summary"]')!.textContent).toBe('6 coached calls across 2 closed deals')
    const rows = document.querySelectorAll('[data-testid="link-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('Emma deal')
    expect(rows[0].textContent).toContain('2 coached calls not on any deal')
    expect(rows[1].textContent).toContain('4 coached calls not on any deal')
    expect(byText(/^Link all 6$/)).not.toBeNull()
  })

  it('one click links one deal; the row stays where it was and reports the REAL number linked', async () => {
    const onChanged = vi.fn()
    act(() => {
      root.render(createElement(LinkCallsDialog, { onClose: vi.fn(), onChanged }))
    })
    await flush()
    click(byText(/^Link 4$/)) // Kevin, second row
    await flush()
    expect(api.linkCoachedCalls).toHaveBeenCalledWith('k')
    const rows = document.querySelectorAll('[data-testid="link-row"]')
    expect(rows).toHaveLength(2) // nothing removed, nothing reordered
    expect(rows[0].textContent).toContain('Emma deal')
    expect(rows[1].textContent).toContain('Linked 4 calls.')
    expect(document.querySelector('[data-testid="link-summary"]')!.textContent).toBe('2 coached calls across 1 closed deal')
    expect(onChanged).toHaveBeenCalled()
  })

  it('"Link all" links the whole set and every row shows what it got', async () => {
    act(() => {
      root.render(createElement(LinkCallsDialog, { onClose: vi.fn() }))
    })
    await flush()
    click(byText(/^Link all 6$/))
    await flush()
    expect(api.linkAllSuggested).toHaveBeenCalledTimes(1)
    const rows = document.querySelectorAll('[data-testid="link-row"]')
    expect(rows[0].textContent).toContain('Linked 2 calls.')
    expect(rows[1].textContent).toContain('Linked 4 calls.')
    // The titles survive the row leaving the live set — the first version read
    // "Deal" here, seen on the founder's real board.
    expect(rows[0].textContent).toContain('Emma deal')
    expect(rows[1].textContent).toContain('Kevin deal')
    expect(document.querySelector('[data-testid="link-summary"]')!.textContent).toBe('Nothing left to link.')
    expect(byText(/^Link all/)).toBeNull()
  })
})
