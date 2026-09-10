// BUG-201 — the four sentences a rep sees when the APP, not the OS and not
// them, declined to record the other party.
//
// Approved by the founder 2026-09-09. They deliberately share the opening of
// the existing `not-ready` line — "Only your side is being recorded — <why>" —
// so the shape is learned once; every one of them is that same situation with
// a known cause. Before this, all four arrived as `'denied'`, whose banner
// says "screen & system-audio recording was blocked". That is true only when
// the OS or the user refused; for the app-side refusals it sends someone
// looking for a permission that is not the problem.
//
// The banner text is asserted against the SOURCE rather than rendered, because
// LiveView pulls in the whole live-call surface (recorder, worklets, CDP
// bridge). What matters here is that the approved wording is present, exactly,
// and that the mapping from main's reason to the code is total — a rendering
// test of one branch would prove less about both.
import { describe, expect, it, vi } from 'vitest'

// platform.ts reads `window.api.platform` at MODULE LOAD, and useTranscription
// imports it. Mocked rather than given a fake window, so the dependency stays
// visible to the next reader.
vi.mock('@renderer/lib/platform', () => ({ isMac: false, isWindows: true }))
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { otherPartyErrorForArmReason } from '../useTranscription'

const LIVE_VIEW = readFileSync(join(__dirname, '..', 'LiveView.tsx'), 'utf8')

/** Comments stripped: a guard that matches its own explanation is not a guard
 *  — the approved sentences are quoted in the comment block above them. */
const code = LIVE_VIEW.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

describe("BUG-201 — main's reason maps onto a renderer code", () => {
  it('maps all four app-side refusals', () => {
    expect(otherPartyErrorForArmReason('platform-unsupported')).toBe('app-platform-unsupported')
    expect(otherPartyErrorForArmReason('master-switch-off')).toBe('app-master-switch-off')
    expect(otherPartyErrorForArmReason('no-live-call')).toBe('app-no-live-call')
    expect(otherPartyErrorForArmReason('consent-not-permitted')).toBe('app-consent-not-permitted')
  })

  it("falls back to 'denied' for anything it does not recognise", () => {
    // Never to a MORE specific claim than the evidence supports: an unknown
    // reason means we do not know who declined, and the old wording is the
    // one that does not assert a cause we cannot name.
    expect(otherPartyErrorForArmReason('unknown')).toBe('denied')
    expect(otherPartyErrorForArmReason('')).toBe('denied')
    expect(otherPartyErrorForArmReason('something-added-later')).toBe('denied')
  })
})

describe('BUG-201 — the approved sentences, word for word', () => {
  const APPROVED: [string, string][] = [
    [
      'app-master-switch-off',
      'Only your side is being recorded — recording the other party is switched off. Turn it on in Settings → Recording & consent.'
    ],
    [
      'app-consent-not-permitted',
      "Only your side is being recorded — this call's consent doesn't cover recording the other party."
    ],
    [
      'app-no-live-call',
      'Only your side is being recorded — the call had already ended when CallRise tried to attach the other party.'
    ],
    [
      'app-platform-unsupported',
      "Only your side is being recorded — CallRise can't capture the other party on this computer."
    ]
  ]

  for (const [codeName, sentence] of APPROVED) {
    it(`${codeName} reads exactly as approved`, () => {
      expect(code, `${codeName}'s branch is missing`).toContain(codeName)
      expect(code, `${codeName}'s approved wording changed`).toContain(sentence)
    })
  }

  it('only the master-switch line offers a fix, because only it has one', () => {
    // The founder's note on the set: it "says what's wrong and where to fix it
    // in the same breath, which none of the others can because none of the
    // others have a fix." Inventing an action for the other three would be
    // worse than saying nothing.
    const withSettingsPath = APPROVED.filter(([, s]) => s.includes('Settings →'))
    expect(withSettingsPath.map(([k]) => k)).toEqual(['app-master-switch-off'])
  })

  it("keeps the OS-permission wording for a genuine 'denied'", () => {
    // The control. If the four new branches had replaced it rather than
    // preceded it, a real OS refusal would stop naming the OS.
    expect(code).toContain('screen & system-audio recording was blocked')
    expect(code).toContain('macOS blocked screen & system-audio recording')
  })
})
