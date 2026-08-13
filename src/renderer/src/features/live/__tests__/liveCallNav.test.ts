// M26 Phase 4.6 — the tiny signal that lets the live-call pill (rendered as
// a sibling of MainApp, outside its tree) tell MainApp to navigate back to
// Live Calls, without lifting MainApp's own nav state anywhere.
import { describe, expect, it } from 'vitest'
import { goToLiveCalls, setGoToLiveCallsListener } from '../liveCallNav'

describe('liveCallNav', () => {
  it('calling goToLiveCalls with no listener registered does not throw', () => {
    setGoToLiveCallsListener(null)
    expect(() => goToLiveCalls()).not.toThrow()
  })

  it('the registered listener fires on goToLiveCalls', () => {
    let called = 0
    setGoToLiveCallsListener(() => {
      called += 1
    })
    try {
      goToLiveCalls()
      goToLiveCalls()
      expect(called).toBe(2)
    } finally {
      setGoToLiveCallsListener(null)
    }
  })

  it('setGoToLiveCallsListener(null) unregisters — mirrors an effect cleanup', () => {
    let called = 0
    setGoToLiveCallsListener(() => {
      called += 1
    })
    setGoToLiveCallsListener(null)
    goToLiveCalls()
    expect(called).toBe(0)
  })

  it('registering a new listener replaces the previous one, not adds to it', () => {
    let first = 0
    let second = 0
    setGoToLiveCallsListener(() => {
      first += 1
    })
    setGoToLiveCallsListener(() => {
      second += 1
    })
    try {
      goToLiveCalls()
      expect(first).toBe(0)
      expect(second).toBe(1)
    } finally {
      setGoToLiveCallsListener(null)
    }
  })
})
