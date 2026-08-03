import { describe, expect, it } from 'vitest'
import { CapturePathSupervisor, SWITCH_TUNING } from '../switch-policy'

/** Drive the supervisor at 100ms intervals. Returns the last verdict. */
function feed(
  supervisor: CapturePathSupervisor,
  ms: number,
  rms: number,
  sessionPeak: number | null,
  fromMs = 0
): { atMs: number; switchedAt: number | null } {
  let at = fromMs
  for (let i = 0; i * 100 < ms; i++) {
    at = fromMs + i * 100
    supervisor.observe({ atMs: at, rms, sessionPeak })
  }
  return { atMs: at, switchedAt: supervisor.switchedAt }
}

const SILENT = 0
const VOICE = 0.2
const PEAKING = 0.3

describe('CapturePathSupervisor', () => {
  it('starts on process loopback', () => {
    expect(new CapturePathSupervisor().currentPath).toBe('process-loopback')
  })

  it('stays put while audio is actually being captured', () => {
    const s = new CapturePathSupervisor()
    feed(s, 30_000, VOICE, PEAKING)
    expect(s.currentPath).toBe('process-loopback')
    expect(s.switchedAt).toBeNull()
  })

  // The whole point: a quiet meeting and a broken capture path both deliver
  // digital silence. Only the render session's own meter tells them apart.
  it('does not switch during a genuinely quiet stretch', () => {
    const s = new CapturePathSupervisor()
    feed(s, 60_000, SILENT, 0) // nobody is talking, nothing is playing
    expect(s.currentPath).toBe('process-loopback')
  })

  // The Teams case (Windows-classic-samples#414): two render sessions, both
  // metering non-zero, and process loopback records silence regardless.
  it('switches when the meter is live but we receive nothing', () => {
    const s = new CapturePathSupervisor()
    const { switchedAt } = feed(s, 5_000, SILENT, PEAKING)
    expect(s.currentPath).toBe('device-loopback')
    expect(switchedAt).not.toBeNull()
  })

  it('waits the full sustain window before switching', () => {
    const s = new CapturePathSupervisor()
    // One sample short of the threshold.
    feed(s, SWITCH_TUNING.sustainedMs, SILENT, PEAKING)
    expect(s.currentPath).toBe('process-loopback')

    s.observe({ atMs: SWITCH_TUNING.sustainedMs + 100, rms: SILENT, sessionPeak: PEAKING })
    expect(s.currentPath).toBe('device-loopback')
  })

  it('resets the suspicion as soon as any audio arrives', () => {
    const s = new CapturePathSupervisor()
    // Nearly there...
    feed(s, SWITCH_TUNING.sustainedMs - 200, SILENT, PEAKING)
    // ...then a real frame proves the path works.
    s.observe({ atMs: 2_000, rms: VOICE, sessionPeak: PEAKING })
    // The clock restarts, so the old near-miss cannot carry over.
    feed(s, SWITCH_TUNING.sustainedMs - 200, SILENT, PEAKING, 2_100)
    expect(s.currentPath).toBe('process-loopback')
  })

  it('resets the suspicion when the app itself goes quiet', () => {
    const s = new CapturePathSupervisor()
    feed(s, SWITCH_TUNING.sustainedMs - 200, SILENT, PEAKING)
    s.observe({ atMs: 2_000, rms: SILENT, sessionPeak: 0 }) // app stopped playing
    feed(s, SWITCH_TUNING.sustainedMs - 200, SILENT, PEAKING, 2_100)
    expect(s.currentPath).toBe('process-loopback')
  })

  // An unreadable meter is the absence of evidence, not evidence of absence.
  // Treating null as "playing" would switch every quiet call to the fallback.
  it('never switches on an unreadable meter', () => {
    const s = new CapturePathSupervisor()
    feed(s, 60_000, SILENT, null)
    expect(s.currentPath).toBe('process-loopback')
  })

  it('ignores a peak too small to mean anything', () => {
    const s = new CapturePathSupervisor()
    feed(s, 60_000, SILENT, SWITCH_TUNING.livePeak / 2)
    expect(s.currentPath).toBe('process-loopback')
  })

  // Device loopback captures everything process loopback does, so a return
  // trip buys nothing and risks oscillating between paths mid-call.
  it('is one-way: nothing moves it off device loopback', () => {
    const s = new CapturePathSupervisor()
    feed(s, 5_000, SILENT, PEAKING)
    expect(s.currentPath).toBe('device-loopback')

    const switchedAt = s.switchedAt
    feed(s, 60_000, VOICE, PEAKING, 10_000) // healthy again
    feed(s, 60_000, SILENT, PEAKING, 80_000) // sick again
    expect(s.currentPath).toBe('device-loopback')
    expect(s.switchedAt).toBe(switchedAt) // and it only ever switched once
  })

  it('explains itself, because the switch has to be readable in a log', () => {
    const s = new CapturePathSupervisor()
    feed(s, SWITCH_TUNING.sustainedMs, SILENT, PEAKING)
    const verdict = s.observe({
      atMs: SWITCH_TUNING.sustainedMs + 100,
      rms: SILENT,
      sessionPeak: PEAKING
    })
    expect(verdict.switched).toBe(true)
    expect(verdict.reason).toContain('device loopback')
    expect(verdict.reason).toContain('0.300')
  })

  it('starts a fresh call back on the primary path', () => {
    const s = new CapturePathSupervisor()
    feed(s, 5_000, SILENT, PEAKING)
    expect(s.currentPath).toBe('device-loopback')
    s.reset()
    expect(s.currentPath).toBe('process-loopback')
    expect(s.switchedAt).toBeNull()
  })
})
