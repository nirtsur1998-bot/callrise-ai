import { describe, expect, it } from 'vitest'
import { IDLE_STOP_MS, IdleStopWatcher, idleStopNotice } from '../auto-stop'

describe('IdleStopWatcher', () => {
  it('does nothing until it is armed', () => {
    const w = new IdleStopWatcher()
    expect(w.isArmed).toBe(false)
    expect(w.evaluate(60 * 60_000).stop).toBe(false)
  })

  it('ends a call once nobody has spoken for the threshold', () => {
    const w = new IdleStopWatcher()
    w.arm(0)
    expect(w.evaluate(IDLE_STOP_MS - 1).stop).toBe(false)
    const decision = w.evaluate(IDLE_STOP_MS)
    expect(decision.stop).toBe(true)
    expect(decision.idleMs).toBe(IDLE_STOP_MS)
  })

  // Real calls contain long pauses — someone is put on hold, pulls up a
  // document. Stopping early truncates a live conversation, which is worse
  // than recording a few extra minutes of nothing.
  it('tolerates a long pause that is followed by more speech', () => {
    const w = new IdleStopWatcher()
    w.arm(0)
    w.noteSpeech(4 * 60_000) // four minutes of silence, then a word
    expect(w.evaluate(IDLE_STOP_MS).stop).toBe(false)
    expect(w.evaluate(4 * 60_000 + IDLE_STOP_MS - 1).stop).toBe(false)
    expect(w.evaluate(4 * 60_000 + IDLE_STOP_MS).stop).toBe(true)
  })

  // The stop it triggers is asynchronous, so an unlatched watcher would fire
  // again on the next tick, before the session had finished closing.
  it('only ever fires once', () => {
    const w = new IdleStopWatcher()
    w.arm(0)
    expect(w.evaluate(IDLE_STOP_MS).stop).toBe(true)
    expect(w.evaluate(IDLE_STOP_MS + 1000).stop).toBe(false)
    expect(w.evaluate(IDLE_STOP_MS * 3).stop).toBe(false)
  })

  // A detected "call" that was never really a call still has to end, or it
  // records an empty room until the app is closed.
  it('ends a session that never produced a single word', () => {
    const w = new IdleStopWatcher()
    w.arm(0)
    expect(w.evaluate(IDLE_STOP_MS).stop).toBe(true)
  })

  it('ignores speech while disarmed, so a stale note cannot re-arm it', () => {
    const w = new IdleStopWatcher()
    w.noteSpeech(1000)
    expect(w.evaluate(IDLE_STOP_MS * 2).stop).toBe(false)
  })

  it('starts clean when re-armed for the next call', () => {
    const w = new IdleStopWatcher()
    w.arm(0)
    expect(w.evaluate(IDLE_STOP_MS).stop).toBe(true)
    w.disarm()
    w.arm(IDLE_STOP_MS)
    expect(w.evaluate(IDLE_STOP_MS + 1000).stop).toBe(false)
    expect(w.evaluate(IDLE_STOP_MS * 2).stop).toBe(true)
  })

  it('reports how long the silence ran, for the notice', () => {
    const w = new IdleStopWatcher(1000)
    w.arm(0)
    expect(w.evaluate(2500).idleMs).toBe(2500)
  })

  it('honours a custom threshold', () => {
    const w = new IdleStopWatcher(10_000)
    w.arm(0)
    expect(w.evaluate(9_999).stop).toBe(false)
    expect(w.evaluate(10_000).stop).toBe(true)
  })
})

describe('idleStopNotice', () => {
  it('explains why the call ended on its own', () => {
    expect(idleStopNotice(IDLE_STOP_MS)).toBe('Call saved — no one had spoken for 5 minutes.')
  })

  it('never claims zero minutes', () => {
    expect(idleStopNotice(500)).toContain('1 minutes')
  })
})
