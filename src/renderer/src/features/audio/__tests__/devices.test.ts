// M21 Phase E — BUG-005: after an audio-driver reinstall the saved mic id goes
// stale. The capture constraint is a soft `ideal` hint, so this never errors —
// the OS just hands back a DIFFERENT microphone and the app records the wrong
// one with nothing shown to the user. These cover resolving by stable identity
// instead of by volatile device id.
import { describe, it, expect } from 'vitest'
import { resolveMic, isCallRiseMic, type MicChoice } from '../devices'

const HEADSET: MicChoice = { deviceId: 'aaa111', label: 'Jabra Evolve 65' }
const BUILTIN: MicChoice = { deviceId: 'bbb222', label: 'MacBook Pro Microphone' }
const CALLRISE: MicChoice = { deviceId: 'ccc333', label: 'Sales OS Microphone' }
const ALL = [HEADSET, BUILTIN, CALLRISE]

describe('isCallRiseMic', () => {
  it('recognises the denoising mic across its platform names', () => {
    expect(isCallRiseMic('Sales OS Microphone')).toBe(true)
    expect(isCallRiseMic('CallRise AI Microphone')).toBe(true)
    expect(isCallRiseMic('Internal Microphone Array - Front')).toBe(true)
  })

  it('does not claim ordinary microphones', () => {
    expect(isCallRiseMic('Jabra Evolve 65')).toBe(false)
    expect(isCallRiseMic('MacBook Pro Microphone')).toBe(false)
  })
})

describe('resolveMic', () => {
  it('keeps a saved device that is still present', () => {
    const r = resolveMic({ deviceId: 'aaa111', label: 'Jabra Evolve 65' }, ALL)
    expect(r.status).toBe('ok')
    expect(r.deviceId).toBe('aaa111')
  })

  it('repairs a stale id by name after a driver reinstall', () => {
    // The reinstall case: same physical mic, brand-new device id.
    const reinstalled = [{ deviceId: 'NEW-GUID-999', label: 'Jabra Evolve 65' }, BUILTIN]
    const r = resolveMic({ deviceId: 'aaa111', label: 'Jabra Evolve 65' }, reinstalled)
    expect(r.status).toBe('repaired')
    expect(r.deviceId).toBe('NEW-GUID-999')
  })

  it('reports a genuinely absent device instead of silently falling back', () => {
    // This is the bug's whole shape: pre-M21 the app just recorded from
    // whatever the OS chose and said nothing.
    const r = resolveMic({ deviceId: 'aaa111', label: 'Jabra Evolve 65' }, [BUILTIN])
    expect(r.status).toBe('missing')
    expect(r.deviceId).toBe('')
    expect(r.label).toBe('Jabra Evolve 65')
  })

  it('auto-selects the denoising mic when nothing has been chosen', () => {
    const r = resolveMic({ deviceId: '', label: '' }, ALL, { preferCallRise: true })
    expect(r.status).toBe('auto-callrise')
    expect(r.deviceId).toBe('ccc333')
  })

  it('never overrides an explicit choice with the denoising mic', () => {
    // Auto-selecting over a deliberate pick would be its own silent-wrong-mic
    // bug, so an existing valid choice always wins.
    const r = resolveMic({ deviceId: 'aaa111', label: 'Jabra Evolve 65' }, ALL, {
      preferCallRise: true
    })
    expect(r.status).toBe('ok')
    expect(r.deviceId).toBe('aaa111')
  })

  it('prefers repairing an explicit choice over auto-selecting CallRise', () => {
    const reinstalled = [{ deviceId: 'NEW-GUID-999', label: 'Jabra Evolve 65' }, CALLRISE]
    const r = resolveMic({ deviceId: 'aaa111', label: 'Jabra Evolve 65' }, reinstalled, {
      preferCallRise: true
    })
    expect(r.status).toBe('repaired')
    expect(r.deviceId).toBe('NEW-GUID-999')
  })

  it('never overrides an explicit "System default" choice', () => {
    // System default is stored as an empty id, which is byte-identical to
    // "never chosen" - so without the explicit marker the auto-select would
    // silently switch the user off their deliberate choice.
    const r = resolveMic({ deviceId: '', label: '', explicit: true }, ALL, {
      preferCallRise: true
    })
    expect(r.status).toBe('none')
    expect(r.deviceId).toBe('')
  })

  it('still auto-selects when the user has genuinely never chosen', () => {
    const r = resolveMic({ deviceId: '', label: '', explicit: false }, ALL, {
      preferCallRise: true
    })
    expect(r.status).toBe('auto-callrise')
  })

  it('leaves the system default alone when nothing is chosen and no CallRise mic exists', () => {
    const r = resolveMic({ deviceId: '', label: '' }, [HEADSET, BUILTIN], { preferCallRise: true })
    expect(r.status).toBe('none')
    expect(r.deviceId).toBe('')
  })

  it('cannot repair a legacy choice that was saved without a label', () => {
    // Pre-M21 choices have no stored label, so a stale id is unrecoverable —
    // it must report missing rather than guess at a device.
    const r = resolveMic({ deviceId: 'aaa111', label: '' }, [BUILTIN])
    expect(r.status).toBe('missing')
  })
})
