import { describe, expect, it } from 'vitest'
import {
  AcquisitionGeneration,
  DEVICE_WATCH_TUNING,
  DeviceWatcher,
  type AudioDevice
} from '../device-watch'

const MIC: AudioDevice = { deviceId: 'built-in', label: 'MacBook Pro Microphone' }
const HEADSET: AudioDevice = { deviceId: 'usb-headset', label: 'Jabra Evolve' }
const WEBCAM: AudioDevice = { deviceId: 'webcam', label: 'Logitech C920' }

const { debounceMs, startupGraceMs } = DEVICE_WATCH_TUNING
/** A time comfortably past both the grace window and a debounce. */
const LATER = startupGraceMs + 10_000

describe('DeviceWatcher startup grace', () => {
  // Electron fires `devicechange` on first device open, before anything has
  // actually changed. Acting on it reacquires the mic seconds after starting
  // the call it was meant to protect.
  it('ignores the spurious event Electron fires on first open', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC, HEADSET])
    w.observe(50, [MIC, HEADSET])
    expect(w.settle(50 + debounceMs, 'usb-headset')).toBeNull()
  })

  it('ignores a real change inside the grace window rather than queueing it', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC, HEADSET])
    w.observe(100, [MIC])
    // Settling later must not resurrect the suppressed snapshot.
    expect(w.settle(startupGraceMs - 1, 'usb-headset')).toBeNull()
    expect(w.settle(LATER, 'usb-headset')).toBeNull()
  })

  it('reports changes once the grace window has passed', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC, HEADSET])
    w.observe(startupGraceMs + 1, [MIC])
    expect(w.settle(startupGraceMs + 1 + debounceMs, 'usb-headset')?.kind).toBe('selected-gone')
  })
})

describe('DeviceWatcher debounce', () => {
  // One USB headset can produce several events as its input and output
  // endpoints appear. Acting on the first means acting on a half-enumerated list.
  it('waits for the burst to finish before deciding', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC])
    w.observe(LATER, [MIC, WEBCAM]) // mid-enumeration
    expect(w.settle(LATER + debounceMs - 1, 'built-in')).toBeNull()
    w.observe(LATER + 50, [MIC, WEBCAM, HEADSET]) // the rest arrives
    const change = w.settle(LATER + 50 + debounceMs, 'built-in')
    expect(change?.kind).toBe('list-changed')
    if (change?.kind === 'list-changed') {
      expect(change.added.map((d) => d.deviceId).sort()).toEqual(['usb-headset', 'webcam'])
    }
  })

  it('reports nothing when there is no pending snapshot', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC])
    expect(w.settle(LATER, 'built-in')).toBeNull()
  })
})

describe('DeviceWatcher diffing', () => {
  // The event carries no payload, so the only honest signal is a diff of the
  // enumerated list — and an event that changed nothing must report nothing.
  it('says nothing when the list is identical', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC, HEADSET])
    w.observe(LATER, [HEADSET, MIC]) // same set, different order
    expect(w.settle(LATER + debounceMs, 'usb-headset')).toBeNull()
  })

  it('reports an addition that does not affect the device in use', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC])
    w.observe(LATER, [MIC, WEBCAM])
    const change = w.settle(LATER + debounceMs, 'built-in')
    expect(change?.kind).toBe('list-changed')
    if (change?.kind === 'list-changed') {
      expect(change.added).toEqual([WEBCAM])
      expect(change.removed).toEqual([])
    }
  })

  it('reports a removal that does not affect the device in use', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC, WEBCAM])
    w.observe(LATER, [MIC])
    const change = w.settle(LATER + debounceMs, 'built-in')
    if (change?.kind === 'list-changed') expect(change.removed).toEqual([WEBCAM])
    else throw new Error('expected list-changed')
  })

  it('re-baselines, so one change is never reported twice', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC])
    w.observe(LATER, [MIC, HEADSET])
    expect(w.settle(LATER + debounceMs, 'built-in')?.kind).toBe('list-changed')
    w.observe(LATER + 5_000, [MIC, HEADSET])
    expect(w.settle(LATER + 5_000 + debounceMs, 'built-in')).toBeNull()
  })
})

describe('the trust bug', () => {
  // "I unplugged my headset and it kept recording the laptop mic." The track
  // does not end — deviceId 'default' was resolved and pinned at acquisition
  // (crbug 40199570) — so nothing else will raise this.
  it('reports the device in use disappearing, distinctly from any other change', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC, HEADSET])
    w.observe(LATER, [MIC])
    const change = w.settle(LATER + debounceMs, 'usb-headset')
    expect(change?.kind).toBe('selected-gone')
    if (change?.kind === 'selected-gone') expect(change.deviceId).toBe('usb-headset')
  })

  it('prioritises it over the unrelated additions in the same event', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC, HEADSET])
    w.observe(LATER, [MIC, WEBCAM]) // headset out, webcam in, one event
    expect(w.settle(LATER + debounceMs, 'usb-headset')?.kind).toBe('selected-gone')
  })

  it('does not claim the selected device vanished when it was never there', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC])
    w.observe(LATER, [MIC, HEADSET])
    expect(w.settle(LATER + debounceMs, 'ghost-device')?.kind).toBe('list-changed')
  })

  it('says nothing about a selection we do not know', () => {
    const w = new DeviceWatcher()
    w.start(0, [MIC, HEADSET])
    w.observe(LATER, [MIC])
    const change = w.settle(LATER + debounceMs, null)
    expect(change?.kind).toBe('list-changed')
  })
})

describe('DeviceWatcher lifecycle', () => {
  it('ignores everything before start and after stop', () => {
    const w = new DeviceWatcher()
    w.observe(LATER, [MIC])
    expect(w.settle(LATER + debounceMs, 'built-in')).toBeNull()

    w.start(0, [MIC, HEADSET])
    w.stop()
    w.observe(LATER, [MIC])
    expect(w.settle(LATER + debounceMs, 'usb-headset')).toBeNull()
  })
})

describe('AcquisitionGeneration', () => {
  // Two overlapping getUserMedia calls produce two live tracks feeding one
  // graph: every word transcribed twice, and a talk ratio claiming the rep
  // spoke for 200% of the call.
  it('lets only the newest attempt install its stream', () => {
    const g = new AcquisitionGeneration()
    const first = g.next()
    const second = g.next()
    expect(g.isCurrent(first)).toBe(false)
    expect(g.isCurrent(second)).toBe(true)
  })

  it('treats a single attempt as current', () => {
    const g = new AcquisitionGeneration()
    expect(g.isCurrent(g.next())).toBe(true)
  })

  it('invalidates everything in flight when capture stops', () => {
    const g = new AcquisitionGeneration()
    const token = g.next()
    g.invalidate()
    expect(g.isCurrent(token)).toBe(false)
  })

  it('never treats a stale token as current again', () => {
    const g = new AcquisitionGeneration()
    const stale = g.next()
    g.next()
    g.next()
    expect(g.isCurrent(stale)).toBe(false)
  })
})
