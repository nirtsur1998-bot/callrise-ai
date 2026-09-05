// BUG-190 — one missing microphone was reported three ways on the Stage 2
// walk: the wizard said "access wasn't granted" (wrong: no OS prompt had
// appeared, there was no device), the live view said "No microphone found"
// (right), the Audio page showed the browser's raw NotFoundError string. One
// classifier, one set of sentences, used by all three.
import { describe, expect, it } from 'vitest'
import {
  classifyMicError,
  MIC_OUTCOME_TEXT,
  dedupeInputDevices,
  micSelectorOptions
} from '../micOutcome'

class FakeDOMException extends Error {
  constructor(name: string, message = '') {
    super(message)
    this.name = name
  }
}

describe('classifyMicError — the browser error names that matter', () => {
  it('no device at all is no-device, never denied', () => {
    expect(classifyMicError(new FakeDOMException('NotFoundError', 'Requested device not found'))).toBe('no-device')
    expect(classifyMicError(new FakeDOMException('OverconstrainedError'))).toBe('no-device')
  })
  it('a refused permission is denied', () => {
    expect(classifyMicError(new FakeDOMException('NotAllowedError'))).toBe('denied')
    expect(classifyMicError(new FakeDOMException('SecurityError'))).toBe('denied')
  })
  it('a device held by another app is busy', () => {
    expect(classifyMicError(new FakeDOMException('NotReadableError'))).toBe('busy')
    expect(classifyMicError(new FakeDOMException('AbortError'))).toBe('busy')
  })
  it('anything else is error, including non-exceptions', () => {
    expect(classifyMicError(new Error('boom'))).toBe('error')
    expect(classifyMicError('string')).toBe('error')
    expect(classifyMicError(undefined)).toBe('error')
  })
})

describe('MIC_OUTCOME_TEXT — the sentences, and where OS settings help', () => {
  it('no-device says no microphone was found and does NOT send anyone to privacy settings', () => {
    const t = MIC_OUTCOME_TEXT['no-device']
    expect(t.title).toBe('No microphone found')
    expect(t.body).toMatch(/Connect a microphone/)
    expect(t.body).not.toMatch(/privacy|OS settings/i)
    expect(t.osSettingsHelp).toBe(false)
  })
  it('denied is the only outcome that points at OS privacy settings', () => {
    expect(MIC_OUTCOME_TEXT.denied.osSettingsHelp).toBe(true)
    expect(MIC_OUTCOME_TEXT.denied.body).toMatch(/privacy settings/i)
    for (const k of ['no-device', 'busy', 'error'] as const) expect(MIC_OUTCOME_TEXT[k].osSettingsHelp).toBe(false)
  })
  it('no sentence is a raw browser string', () => {
    for (const t of Object.values(MIC_OUTCOME_TEXT)) {
      expect(t.title).not.toMatch(/Requested device|no supported source|NotFoundError|NotAllowedError/)
      expect(t.body).not.toMatch(/Requested device|no supported source|NotFoundError|NotAllowedError/)
    }
  })
})

describe('dedupeInputDevices — Chromium\'s "Default -" / "Communications -" aliases', () => {
  const remote = [
    { deviceId: 'default', label: 'Default - Remote Audio' },
    { deviceId: 'communications', label: 'Communications - Remote Audio' },
    { deviceId: 'abc123', label: 'Remote Audio' }
  ]
  it('one physical device shown three times becomes one entry', () => {
    expect(dedupeInputDevices(remote)).toEqual([{ deviceId: 'abc123', label: 'Remote Audio' }])
  })
  it('keeps the default alias when it is the only entry, with the prefix stripped', () => {
    expect(dedupeInputDevices([{ deviceId: 'default', label: 'Default - Headset Mic' }])).toEqual([
      { deviceId: 'default', label: 'Headset Mic' }
    ])
  })
  it('never invents a device and leaves unlabeled lists alone', () => {
    expect(dedupeInputDevices([])).toEqual([])
    const unlabeled = [{ deviceId: 'x', label: 'Microphone 1' }]
    expect(dedupeInputDevices(unlabeled)).toEqual(unlabeled)
  })
  it('a list with two real devices keeps both and drops both aliases', () => {
    const list = [
      { deviceId: 'default', label: 'Default - Headset Mic' },
      { deviceId: 'communications', label: 'Communications - Webcam Mic' },
      { deviceId: 'h1', label: 'Headset Mic' },
      { deviceId: 'w1', label: 'Webcam Mic' }
    ]
    expect(dedupeInputDevices(list).map((d) => d.deviceId)).toEqual(['h1', 'w1'])
  })
})

describe('micSelectorOptions — "System default" is not offered when there is nothing to default to', () => {
  it('with no inputs, one disabled option that says so', () => {
    expect(micSelectorOptions([])).toEqual([{ value: '', label: 'No microphone found', disabled: true }])
  })
  it('with inputs, System default first then each device', () => {
    expect(micSelectorOptions([{ deviceId: 'a', label: 'Mic A' }])).toEqual([
      { value: '', label: 'System default', disabled: false },
      { value: 'a', label: 'Mic A', disabled: false }
    ])
  })
})
