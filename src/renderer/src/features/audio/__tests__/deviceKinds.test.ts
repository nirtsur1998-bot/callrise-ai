// BUG-122 — the bundle carries a classification, never a label.
import { describe, expect, it } from 'vitest'
import { classifyDeviceLabel, summarizeDevices, VIRTUAL_MIC_NAME } from '../deviceKinds'

describe('classifyDeviceLabel', () => {
  it("recognises OUR virtual mic by the name we control, and the founder's real device kinds", () => {
    expect(classifyDeviceLabel(`${VIRTUAL_MIC_NAME} (CallRise AI Audio)`)).toBe('virtual')
    expect(classifyDeviceLabel("Dana Whitfield's AirPods")).toBe('bluetooth')
    expect(classifyDeviceLabel('Headset (Jabra Evolve2 65) Hands-Free AG Audio')).toBe('bluetooth')
    expect(classifyDeviceLabel('Microphone (Yeti Stereo Microphone)')).toBe('usb')
    expect(classifyDeviceLabel('Microphone Array (Realtek(R) Audio)')).toBe('builtin')
    expect(classifyDeviceLabel('Line In (Something Obscure)')).toBe('other')
  })
})

describe('summarizeDevices — what leaves the machine', () => {
  it('is a triple with no label in it, however personal the label was', () => {
    const s = summarizeDevices(["Dana Whitfield's AirPods", 'Microphone Array (Realtek(R) Audio)', VIRTUAL_MIC_NAME])
    expect(s).toEqual({ hasVirtualMic: true, inputCount: 3, kinds: ['bluetooth', 'builtin', 'virtual'] })
    expect(JSON.stringify(s)).not.toContain('Dana')
    expect(JSON.stringify(s)).not.toContain('AirPods')
  })
  it('an empty list is an honest zero, not an error', () => {
    expect(summarizeDevices([])).toEqual({ hasVirtualMic: false, inputCount: 0, kinds: [] })
  })
})
