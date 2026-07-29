// Headphone detection (M19 Task 2, Part A) — a best-effort heuristic warning
// for the loudspeaker/echo problem: per-channel attribution is only
// deterministic when the rep wears headphones (otherwise the buyer's voice
// leaks back into the mic via the speakers). There is no OS API that
// directly answers "are headphones on the rep's head" — this checks the
// active OUTPUT device's label for known headphone/earbud vocabulary, which
// is what's actually available cross-platform without native code.

/** Patterns that indicate a headphone/earbud-class output device. Checked in
 *  this order — headphone-ish patterns first, so "Bluetooth Headphones"
 *  matches on "headphone" rather than being ambiguous. */
const HEADPHONE_PATTERNS = [
  /headphone/i,
  /headset/i,
  /earbud/i,
  /earphone/i,
  /airpods/i,
  /buds?/i,
  /\bear\b/i
]

/** Patterns that indicate a speaker/built-in-output device — checked only
 *  when nothing above matched, since some generic Bluetooth device names
 *  ("Bluetooth Audio") are ambiguous either way and shouldn't false-positive
 *  as "definitely speakers". */
const SPEAKER_PATTERNS = [
  /speaker/i,
  /built-?in/i,
  /internal/i,
  /realtek/i,
  /^default$/i,
  /monitor/i,
  /display/i,
  /\btv\b/i
]

export type HeadphoneVerdict = 'headphones' | 'speakers' | 'unknown'

/** Windows combo-jack devices report a label naming a switchable physical
 *  jack -- "Speakers / Headphones (Realtek(R) Audio)" -- rather than
 *  whatever's actually plugged in right now. That's different from a label
 *  where one word merely modifies the other (e.g. "Bluetooth Headphones
 *  (Speaker Mode)", which IS a headphone device): here "speakers" and
 *  "headphones" are two alternatives joined by a slash, so neither verdict
 *  is safe. Checked before HEADPHONE_PATTERNS so this doesn't silently
 *  suppress the loudspeaker-echo warning on the single most common Windows
 *  output label. */
const COMBO_JACK_PATTERN = /speakers?\s*\/\s*headphones?|headphones?\s*\/\s*speakers?/i

/** Pure classification of one device label. Exported separately from the
 *  enumerateDevices() call below so the heuristic itself is unit-testable
 *  without a browser environment. */
export function classifyOutputLabel(label: string): HeadphoneVerdict {
  const trimmed = label.trim()
  if (!trimmed) return 'unknown'
  if (COMBO_JACK_PATTERN.test(trimmed)) return 'unknown'
  if (HEADPHONE_PATTERNS.some((re) => re.test(trimmed))) return 'headphones'
  if (SPEAKER_PATTERNS.some((re) => re.test(trimmed))) return 'speakers'
  return 'unknown'
}

/**
 * Best-effort check of the CURRENT default audio output device. Returns
 * 'unknown' (never throws) when device labels aren't available yet (no
 * media permission granted in this session) or the API isn't supported —
 * callers should treat 'unknown' as "don't warn", not "assume speakers",
 * since a false warning on a real headphone setup would train the rep to
 * ignore it.
 */
export async function detectOutputDevice(): Promise<HeadphoneVerdict> {
  if (!navigator.mediaDevices?.enumerateDevices) return 'unknown'
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const outputs = devices.filter((d) => d.kind === 'audiooutput')
    if (outputs.length === 0) return 'unknown'
    // No reliable "this one is currently selected" flag cross-platform —
    // the first device Chromium reports is consistently the system default
    // in practice, and 'default'/'communications' pseudo-devices (when
    // present) are checked first since their label sometimes embeds the
    // real device name (e.g. "Default - Headphones (...)").
    const withDefault = outputs.find((d) => d.deviceId === 'default') ?? outputs[0]
    return classifyOutputLabel(withDefault.label)
  } catch {
    return 'unknown'
  }
}
