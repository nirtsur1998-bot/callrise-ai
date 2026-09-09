// @vitest-environment happy-dom
//
// BUG-237, RENDERED — the destructive button that silently did nothing.
//
// There is already a source-level guard for this (forget-everything-cannot-
// no-op.test.ts). It asserts SHAPE: that the off-branch exists, that the
// return value is assigned, that the strings are present. Shape is the right
// thing to pin against a refactor, but it is not the same as behaviour: every
// one of those assertions passes against a component that renders the branch
// and then throws on click.
//
// So this renders the real component and presses the real button. It is the
// half the release walk could not reach any other way — the Memory Center sits
// behind the app's auth screen, and the erase itself was driven separately
// against a real 73-memory database through the production IPC path
// (73 -> 0 with Sales Brain on, refused and untouched with it off). What that
// drive could not exercise is React's own click handling. This does.
//
// The four things that make the bug impossible, in the order they failed:
//   1. with Sales Brain OFF the button is not offered at all
//   2. cancelling the confirm does not erase
//   3. a refused erase SAYS SO instead of looking identical to a success
//   4. a successful erase re-reads the list
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Memory } from '../../../../../preload/index.d'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// vi.mock is hoisted above every import, so the toggle it reads has to be
// hoisted with it — a plain `let` here is in the temporal dead zone when the
// factory runs.
const state = vi.hoisted(() => ({ brainOn: true }))
vi.mock('../useAppSettings', () => ({
  useAppSettings: () => ({ settings: { salesBrain: { enabled: state.brainOn } } })
}))

const { MemoryCenterSection } = await import('../MemoryCenterSection')

function mem(id: string): Memory {
  return {
    id,
    scope: 'rep',
    category: 'stated-goal',
    statement: 'they sell to mid-market ops teams',
    evidence: [],
    confidence: 0.9,
    importance: 5,
    status: 'active',
    source: 'auto',
    pinned: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    lastConfirmedAt: '2026-09-01T00:00:00.000Z'
  }
}

let container: HTMLDivElement
let root: Root
const api = {
  list: vi.fn(async (): Promise<Memory[]> => [mem('m1'), mem('m2')]),
  temporalRecord: vi.fn(async () => null),
  changelog: vi.fn(async () => []),
  forgetEverything: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true }))
}

beforeEach(() => {
  state.brainOn = true
  ;(window as unknown as { api: unknown }).api = { salesBrain: { memories: api } }
  window.confirm = vi.fn(() => true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(MemoryCenterSection))
  })
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

/** The button by its exact label, or null. Never "the nearest plausible one". */
function forgetButton(): HTMLButtonElement | null {
  const hits = [...container.querySelectorAll('button')].filter(
    (b) => (b.textContent || '').trim() === 'Forget everything'
  )
  if (hits.length > 1) throw new Error(`ambiguous: ${hits.length} buttons read "Forget everything"`)
  return (hits[0] as HTMLButtonElement) ?? null
}

async function press(b: HTMLButtonElement): Promise<void> {
  await act(async () => {
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

describe('BUG-237 — the erase button, rendered', () => {
  it('with Sales Brain OFF the button is not offered, and the card says why', async () => {
    state.brainOn = false
    await render()
    expect(forgetButton(), 'a destructive button was offered while the feature is off').toBeNull()
    const text = container.textContent ?? ''
    expect(text).toContain('Sales Brain is switched off, so there is nothing stored to forget')
    expect(text).toContain('Turn it on above')
  })

  it('with Sales Brain ON the button is offered', async () => {
    await render()
    // The other direction. Without this, hiding the button unconditionally
    // would pass the test above and take the feature with it.
    expect(forgetButton()).not.toBeNull()
  })

  it('cancelling the confirm erases nothing', async () => {
    window.confirm = vi.fn(() => false)
    await render()
    await press(forgetButton()!)
    expect(api.forgetEverything).not.toHaveBeenCalled()
  })

  it('a refused erase says so, and says the memories are still there', async () => {
    // THE BUG. The handler returns {ok:false} whenever Sales Brain is off or
    // the database will not open; the old renderer discarded it and called
    // refresh(), so the screen was identical to a successful erase.
    api.forgetEverything.mockResolvedValueOnce({ ok: false })
    await render()
    await press(forgetButton()!)
    const text = container.textContent ?? ''
    expect(text).toContain('Nothing was erased')
    expect(text).toContain('Your memories are still here')
  })

  it('a thrown erase also says so rather than looking like a success', async () => {
    api.forgetEverything.mockRejectedValueOnce(new Error('ipc died'))
    await render()
    await press(forgetButton()!)
    expect(container.textContent ?? '').toContain('Nothing was erased')
  })

  it('a successful erase shows no failure message and re-reads the list', async () => {
    await render()
    const listCallsBefore = api.list.mock.calls.length
    await press(forgetButton()!)
    expect(container.textContent ?? '').not.toContain('Nothing was erased')
    expect(
      api.list.mock.calls.length,
      'a successful erase must re-read the list, or the screen keeps showing erased memories'
    ).toBeGreaterThan(listCallsBefore)
  })
})
