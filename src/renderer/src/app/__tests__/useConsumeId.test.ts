// @vitest-environment happy-dom
//
// BUG-289 — the one-shot-consume prop shape ("open this record, then let the
// parent clear it") shipped with a boolean latch instead of an id-keyed one
// in ContactsView and DealsView, and again one layer up in CrmView's own
// openDealId/openContactId. PastCallsView had ALREADY found and fixed this
// exact shape in M31 ("the first click worked, and every later one silently
// did nothing"), but the fix was never carried to its siblings when they were
// built with the same shape. This hook is the one place it lives now, so a
// fourth sighting isn't possible without touching this file.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConsumeId } from '../useConsumeId'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useConsumeId — a REPEAT id applies once, a DIFFERENT id always applies', () => {
  let container: HTMLDivElement
  let root: Root
  let consumed: string[]
  let resetFn: () => void

  function Probe({ id }: { id: string | null }): null {
    const { reset } = useConsumeId(id, (consumedId) => consumed.push(consumedId))
    resetFn = reset
    return null
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    consumed = []
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (id: string | null): void => {
    act(() => root.render(createElement(Probe, { id })))
  }

  it('a null id consumes nothing', () => {
    render(null)
    expect(consumed).toEqual([])
  })

  it('the first non-null id is consumed exactly once', () => {
    render('a')
    expect(consumed).toEqual(['a'])
    render('a')
    render('a')
    expect(consumed, 'a repeat of the same id must not re-fire').toEqual(['a'])
  })

  it('this is the M31 regression itself: two DIFFERENT ids in a row, no unmount in between', () => {
    // The exact failure BUG-289 reproduced: a second RECENT/palette click for
    // a different record, reached while the screen stayed mounted (no
    // navigation-triggered remount) — this is what a boolean latch drops.
    render('a')
    render('b')
    render('c')
    expect(consumed).toEqual(['a', 'b', 'c'])
  })

  it('the ref tracks only the immediately-prior value, not a history — going back to A after B reopens A', () => {
    // This is what makes "open record B, then go back to record A" work at
    // all: the guard compares against the LAST id seen, not a visited-set.
    render('a')
    render('b')
    render('a')
    expect(consumed).toEqual(['a', 'b', 'a'])
  })

  it('reset() lets the SAME id apply again after the prop cycled through null — what BUG-286 stepping-out needs', () => {
    // Mirrors the real lifecycle exactly: consuming an id always clears the
    // PARENT's prop back to null in the same tick (onInitialXConsumed), so a
    // second click on the same recent row always arrives as null -> id, a
    // real dependency-array change React WILL re-run the effect for. What
    // reset() fixes is the internal memory that would otherwise still say
    // "id was already seen" and block it even though the effect did re-run.
    render('a')
    render(null)
    expect(consumed).toEqual(['a'])
    render('a')
    expect(consumed, 'without reset, the ref still remembers a and blocks it').toEqual(['a'])

    act(() => resetFn())
    render(null)
    render('a')
    expect(consumed, 'after reset, the same cycle consumes a again').toEqual(['a', 'a'])
  })

  it('does not fire again on an unrelated re-render with the same id (no onConsume-identity dependency)', () => {
    const spy = vi.fn()
    function ProbeWithChangingCallback({ id, n }: { id: string; n: number }): null {
      // A fresh closure every render, on purpose — this must not retrigger
      // the effect just because `n` changed and re-rendered the component.
      useConsumeId(id, () => spy(n))
      return null
    }
    act(() => root.render(createElement(ProbeWithChangingCallback, { id: 'a', n: 1 })))
    act(() => root.render(createElement(ProbeWithChangingCallback, { id: 'a', n: 2 })))
    act(() => root.render(createElement(ProbeWithChangingCallback, { id: 'a', n: 3 })))
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
