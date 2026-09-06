// BUG-171 — the Voice AI rail gives way to the centre column below a floor,
// and the user's own choice survives the window being narrow for a while.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CENTRE_FLOOR_PX,
  effectiveVoiceAiCollapsed,
  SIDEBAR_WIDTH_PX,
  VOICE_AI_COLLAPSED_WIDTH_PX,
  VOICE_AI_EXPANDED_WIDTH_PX,
  VOICE_AI_FITS_FROM_PX,
  voiceAiFitsAt
} from '../voiceAiFit'

describe('voiceAiFitsAt — the floor the founder chose', () => {
  it('the floor is 560px of centre; with 240 + 320 of rails that is a 1120px window', () => {
    expect(CENTRE_FLOOR_PX).toBe(560)
    expect(VOICE_AI_FITS_FROM_PX).toBe(1120)
  })

  it("fits at the founder's 1280 and at exactly the threshold; not one pixel under it", () => {
    expect(voiceAiFitsAt(1280)).toBe(true)
    expect(voiceAiFitsAt(1120)).toBe(true)
    expect(voiceAiFitsAt(1119)).toBe(false)
  })

  it('does not fit at an ordinary 1100 laptop window or at the 880 window minimum', () => {
    expect(voiceAiFitsAt(1100)).toBe(false)
    expect(voiceAiFitsAt(880)).toBe(false)
  })

  it('a width that is not a number never "fits" (a rail open on a NaN is the bug again)', () => {
    expect(voiceAiFitsAt(Number.NaN)).toBe(false)
    expect(voiceAiFitsAt(Number.POSITIVE_INFINITY)).toBe(true)
  })
})

describe('effectiveVoiceAiCollapsed — the choice is remembered, the width decides', () => {
  it('a user who expanded it gets it back the moment the window is wide enough', () => {
    expect(effectiveVoiceAiCollapsed(false, 1100)).toBe(true) // folded for now
    expect(effectiveVoiceAiCollapsed(false, 1280)).toBe(false) // straight back
  })

  it('a user who collapsed it keeps it collapsed at any width', () => {
    expect(effectiveVoiceAiCollapsed(true, 1100)).toBe(true)
    expect(effectiveVoiceAiCollapsed(true, 2560)).toBe(true)
  })
})

describe('the numbers match the shell (one source of truth, pinned to the classes)', () => {
  const shell = readFileSync(join(__dirname, '..', '..', '..', 'app', 'AppShell.tsx'), 'utf8')

  it('sidebar w-60 = 240, rail w-80 = 320 expanded and w-16 = 64 collapsed', () => {
    expect(shell).toMatch(/<aside className="w-60 /)
    expect(SIDEBAR_WIDTH_PX).toBe(60 * 4)
    expect(shell).toContain("copilotCollapsed ? 'w-16' : 'w-80'")
    expect(VOICE_AI_COLLAPSED_WIDTH_PX).toBe(16 * 4)
    expect(VOICE_AI_EXPANDED_WIDTH_PX).toBe(80 * 4)
  })
})

describe('MainApp actually uses it (a rule the shell does not read is not a rule)', () => {
  const mainApp = readFileSync(join(__dirname, '..', '..', '..', 'app', 'MainApp.tsx'), 'utf8')

  it('the shell receives the EFFECTIVE collapse, derived from the window width', () => {
    expect(mainApp).toContain('effectiveVoiceAiCollapsed(')
    expect(mainApp).toMatch(/copilotCollapsed=\{effectiveCopilotCollapsed\}/)
  })
})
