import { describe, expect, it } from 'vitest'
import { capturedJustWentLive, playCaptureLiveChime } from '../capture-chime'

describe('capturedJustWentLive', () => {
  it('is true only on the false -> true transition', () => {
    expect(capturedJustWentLive(false, true)).toBe(true)
  })

  it('is false once already live (no re-firing every render)', () => {
    expect(capturedJustWentLive(true, true)).toBe(false)
  })

  it('is false on the way down', () => {
    expect(capturedJustWentLive(true, false)).toBe(false)
  })

  it('is false while staying off', () => {
    expect(capturedJustWentLive(false, false)).toBe(false)
  })
})

describe('playCaptureLiveChime', () => {
  it('never throws, even with no AudioContext in the environment', () => {
    // This suite runs under vitest's node environment — there is no
    // AudioContext at all. The chime is best-effort UI polish; it must never
    // be capable of taking the call down with it.
    expect(() => playCaptureLiveChime()).not.toThrow()
  })
})
