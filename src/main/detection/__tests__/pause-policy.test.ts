// BUG-118 — pausing detection mid-capture defers rather than strands.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shouldDeferPause } from '../pause-policy'

describe('shouldDeferPause', () => {
  it('defers while a capture is live or ending', () => {
    expect(shouldDeferPause('capturing')).toBe(true)
    expect(shouldDeferPause('capturing-with-pending')).toBe(true)
    expect(shouldDeferPause('ending')).toBe(true)
  })
  it('pauses immediately from every state where nothing is being recorded', () => {
    expect(shouldDeferPause('idle')).toBe(false)
    expect(shouldDeferPause('candidate')).toBe(false)
    expect(shouldDeferPause('detected')).toBe(false)
  })
})

describe('detection-service uses it (pinned as text: the service needs Electron)', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'detection-service.ts'), 'utf8')
  it('pauseDetection consults the policy BEFORE stopping the detector', () => {
    const i = src.indexOf('function pauseDetection(): void {')
    const body = src.slice(i, src.indexOf('\n}\n', i))
    expect(body.indexOf('shouldDeferPause(')).toBeGreaterThan(0)
    expect(body.indexOf('shouldDeferPause(')).toBeLessThan(body.indexOf('detector?.stop()'))
    expect(body).toContain('pauseWhenCaptureEnds = true')
  })
  it('the deferred pause is applied on capture-ended, and cleared by resume', () => {
    expect(src).toMatch(/event\.type === 'capture-ended' && pauseWhenCaptureEnds/)
    const r = src.indexOf('function resumeDetection(): void {')
    expect(src.slice(r, r + 200)).toContain('pauseWhenCaptureEnds = false')
  })
})
