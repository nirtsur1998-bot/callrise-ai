// @vitest-environment happy-dom
// M36 Stage 3 item 5, step 5 — THE MEMORY CENTER SHOWS THE WINDOW. The
// founder: "a fact that quietly disappears from view because it was
// superseded would read as data loss. Show the window. And show superseded
// facts distinctly rather than hiding them — 'was true from March to July'
// is information I want, not clutter." Rendered for real (react-dom/client,
// happy-dom), with the preload API stubbed at window.api.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memory, TemporalBackfillRecord } from '../../../../../preload/index.d'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../useAppSettings', () => ({
  useAppSettings: () => ({ settings: { salesBrain: { enabled: true } } })
}))

const { MemoryCenterSection, temporalSummaryText, validityText } = await import('../MemoryCenterSection')

function mem(id: string, statement: string, extra: Partial<Memory> = {}): Memory {
  return {
    id,
    scope: 'rep',
    category: 'stated-goal',
    statement,
    evidence: [],
    confidence: 0.9,
    importance: 5,
    status: 'active',
    source: 'auto',
    pinned: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastConfirmedAt: '2026-09-01T00:00:00.000Z',
    ...extra
  }
}

const RAN: TemporalBackfillRecord = {
  status: 'ran',
  ranAt: '2026-09-06T11:00:00.000Z',
  total: 73,
  datedBefore: 0,
  validFrom: { call: 70, stated: 0, approx: 3 },
  validUntil: { call: 1, stated: 0, approx: 0, none: 0 },
  callsReferenced: 46,
  callsResolved: 43
}

let container: HTMLDivElement
let root: Root
const api = {
  list: vi.fn(async (): Promise<Memory[]> => []),
  temporalRecord: vi.fn(async (): Promise<TemporalBackfillRecord | null> => null),
  changelog: vi.fn(async () => [])
}

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { salesBrain: { memories: api } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  api.list.mockReset()
  api.temporalRecord.mockReset()
})

async function renderSection(): Promise<void> {
  await act(async () => {
    root.render(createElement(MemoryCenterSection))
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('validityText (pure)', () => {
  it('undated → null; live → "True since"; superseded → "Was true … – …"; approximate → "around"', () => {
    expect(validityText(mem('a', 'x'))).toBeNull()
    expect(validityText(mem('b', 'x', { validFrom: '2026-03-14T10:00:00.000Z', validFromSource: 'call' }))).toMatch(/^True since .*2026$/)
    expect(
      validityText(
        mem('c', 'x', {
          status: 'invalidated',
          validFrom: '2026-03-14T10:00:00.000Z',
          validFromSource: 'call',
          validUntil: '2026-07-02T15:30:00.000Z',
          validUntilSource: 'call'
        })
      )
    ).toMatch(/^Was true .* – .*2026$/)
    expect(validityText(mem('d', 'x', { validFrom: '2026-05-12T10:00:00.000Z', validFromSource: 'approx' }))).toMatch(/^True since around /)
  })
})

describe('temporalSummaryText (pure)', () => {
  it('the founder\'s counts, in words; a skip says so; nothing → null', () => {
    expect(temporalSummaryText(RAN)).toBe('73 facts: 70 dated from the call they came from, 3 only by when they were learned (approximate).')
    expect(temporalSummaryText({ status: 'skipped', at: 'x', reason: 'connection replaced during startup' })).toContain('skipped')
    expect(temporalSummaryText(null)).toBeNull()
  })
})

describe('MemoryCenterSection (rendered)', () => {
  it('a superseded fact keeps its row, is marked Replaced, and says the period it covered; a live fact says since when', async () => {
    api.list.mockResolvedValue([
      mem('live', 'Budget ceiling is 55k', { validFrom: '2026-07-02T15:30:00.000Z', validFromSource: 'call' }),
      mem('old', 'Budget ceiling is 40k', {
        status: 'invalidated',
        invalidatedBy: 'live',
        validFrom: '2026-03-14T10:00:00.000Z',
        validFromSource: 'call',
        validUntil: '2026-07-02T15:30:00.000Z',
        validUntilSource: 'call'
      }),
      mem('undated', 'Prefers morning calls')
    ])
    api.temporalRecord.mockResolvedValue(RAN)
    await renderSection()

    const text = container.textContent ?? ''
    expect(text).toContain('Budget ceiling is 40k') // not hidden
    expect(text).toContain('Replaced')
    const validity = [...container.querySelectorAll('[data-testid="memory-validity"]')].map((el) => el.textContent)
    expect(validity).toHaveLength(2) // the undated row claims nothing
    expect(validity.some((t) => t?.startsWith('Was true '))).toBe(true)
    expect(validity.some((t) => t?.startsWith('True since '))).toBe(true)
    // superseded reads differently from live
    const superseded = [...container.querySelectorAll('[data-testid="memory-validity"]')].find((el) => el.textContent?.startsWith('Was true'))!
    expect(superseded.className).toContain('text-danger')

    const summary = container.querySelector('[data-testid="memory-temporal-summary"]')!
    expect(summary.textContent).toContain('73 facts: 70 dated from the call they came from, 3 only by when they were learned (approximate).')
  })

  it('no record → no summary card, and undated rows render exactly as before', async () => {
    api.list.mockResolvedValue([mem('u', 'Prefers morning calls')])
    api.temporalRecord.mockResolvedValue(null)
    await renderSection()
    expect(container.querySelector('[data-testid="memory-temporal-summary"]')).toBeNull()
    expect(container.querySelector('[data-testid="memory-validity"]')).toBeNull()
    expect(container.textContent).toContain('Prefers morning calls')
  })
})
