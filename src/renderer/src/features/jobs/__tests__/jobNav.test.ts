import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { jobTarget, openJobTarget, setJobNavListener } from '../jobNav'

/**
 * "Take me to the thing that job was about."
 *
 * The failure mode worth guarding is not "the click does nothing" — that is
 * visible immediately. It is a row that LOOKS clickable and lands somewhere
 * wrong or nowhere, which is worse than no link at all: it teaches people the
 * links can't be trusted, and they stop using the ones that work.
 */

afterEach(() => setJobNavListener(null))

describe('jobTarget', () => {
  it('is navigable only when BOTH the id and its kind are present', () => {
    expect(jobTarget({ targetRef: 'call-1', targetKind: 'call' })).toEqual({
      kind: 'call',
      id: 'call-1'
    })
    // A ref with no kind is the state every job was in before this shipped:
    // the id is there, but nothing says which screen opens it. Rendering that
    // as a link would be a guess.
    expect(jobTarget({ targetRef: 'call-1' })).toBeNull()
    // A kind with no ref is a job type that declared a destination for inputs
    // it didn't get one from (targetRefFor returning undefined).
    expect(jobTarget({ targetKind: 'call' })).toBeNull()
    expect(jobTarget({})).toBeNull()
  })

  it('passes the kind through rather than inferring it from the id', () => {
    // Every id in this app is a uuid, so kind can NEVER be recovered from the
    // ref. If this ever starts guessing, a contact job opens a call screen.
    expect(jobTarget({ targetRef: 'x', targetKind: 'contact' })?.kind).toBe('contact')
    expect(jobTarget({ targetRef: 'x', targetKind: 'deal' })?.kind).toBe('deal')
  })
})

describe('openJobTarget', () => {
  it('delivers the request to the registered listener', () => {
    const seen = vi.fn()
    setJobNavListener(seen)
    openJobTarget({ kind: 'call', id: 'abc' })
    expect(seen).toHaveBeenCalledWith({ kind: 'call', id: 'abc' })
  })

  it('is a silent no-op with no listener — never throws', () => {
    // Toasts fire during sign-in and onboarding, when MainApp is not mounted
    // and there is nothing to navigate. Throwing there would take down the
    // toast host over a click that simply had nowhere to go.
    setJobNavListener(null)
    expect(() => openJobTarget({ kind: 'call', id: 'abc' })).not.toThrow()
  })

  it('replaces the listener rather than accumulating them', () => {
    // MainApp registers in an effect; a remount must not leave the previous
    // instance's callback live, or one click navigates two trees.
    const first = vi.fn()
    const second = vi.fn()
    setJobNavListener(first)
    setJobNavListener(second)
    openJobTarget({ kind: 'deal', id: 'd1' })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
