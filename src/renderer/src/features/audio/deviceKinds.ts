// BUG-122 — the diagnostics bundle used to carry every microphone's NAME
// ("Dana's AirPods"), and the scrubber structurally cannot catch a bare name
// (it refuses to match a username as a bare word — on a machine whose account
// is literally "User" that would eat every sentence). You cannot scrub a
// name, only refuse to include it. Founder, 2026-08-25, confirmed 2026-09-05:
// "labels don't go in the bundle at all."
//
// What support actually needs from the device list is answered by a derived
// triple instead — is OUR virtual mic present, how many inputs, and what
// KINDS they are — computed from keywords in the label, never the label.

export type DeviceKind = 'virtual' | 'bluetooth' | 'usb' | 'builtin' | 'other'

export interface DeviceSummary {
  /** Our own virtual endpoint is enumerated — matched against a name WE control. */
  hasVirtualMic: boolean
  /** How many audio inputs the browser enumerated. */
  inputCount: number
  /** One entry per input, keyword-derived. Order matches enumeration. */
  kinds: DeviceKind[]
}

/** The virtual microphone's friendly name (see the driver's INF); the one
 *  string in a device list that is ours rather than the user's. */
export const VIRTUAL_MIC_NAME = 'CallRise AI Microphone'

export function classifyDeviceLabel(label: string): DeviceKind {
  const l = label.toLowerCase()
  if (l.includes(VIRTUAL_MIC_NAME.toLowerCase()) || /\bvirtual\b|vb-audio|cable output/.test(l)) return 'virtual'
  if (/bluetooth|airpods|hands-free|\bbt\b|\bhfp\b|\ba2dp\b/.test(l)) return 'bluetooth'
  if (/\busb\b|yeti|blue snowball|\brode\b|shure|jabra|logitech|plantronics|poly\b|elgato/.test(l)) return 'usb'
  if (/realtek|conexant|intel smart sound|built-in|builtin|internal|microphone array|\barray\b|cirrus|synaptics/.test(l)) return 'builtin'
  return 'other'
}

export function summarizeDevices(inputLabels: readonly string[]): DeviceSummary {
  const kinds = inputLabels.map(classifyDeviceLabel)
  return {
    hasVirtualMic: kinds.includes('virtual'),
    inputCount: inputLabels.length,
    kinds
  }
}
