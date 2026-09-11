// M39 — reading the build version must never be able to throw.
//
// One of its callers is interrupted-call recovery, behind an IPC handler that
// turns any throw into `{ ok: false }`. A version read that threw would not show
// up as an error; it would silently fail to rescue a call the rep asked us to
// save. Found the day the field was added: seven recovery tests went red with
// `app.getVersion is not a function`, because their electron mock had no such
// surface. The tests were loud about it. Production would not have been.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ app: {} as Record<string, unknown> }))
vi.mock('electron', () => ({ app: state.app }))

const { currentAppVersion } = await import('../app-version')

beforeEach(() => {
  for (const k of Object.keys(state.app)) delete state.app[k]
})

describe('currentAppVersion', () => {
  it('returns the version a real build reports', () => {
    state.app.getVersion = () => '1.12.0'
    expect(currentAppVersion()).toBe('1.12.0')
  })

  it('is undefined, not a throw, when getVersion does not exist', () => {
    // The exact shape three test mocks had.
    expect(() => currentAppVersion()).not.toThrow()
    expect(currentAppVersion()).toBeUndefined()
  })

  it('is undefined, not a throw, when getVersion throws', () => {
    state.app.getVersion = () => {
      throw new Error('boom')
    }
    expect(() => currentAppVersion()).not.toThrow()
    expect(currentAppVersion()).toBeUndefined()
  })

  it('treats an empty or non-string version as absent', () => {
    state.app.getVersion = () => ''
    expect(currentAppVersion()).toBeUndefined()
    state.app.getVersion = () => 42
    expect(currentAppVersion()).toBeUndefined()
  })
})
