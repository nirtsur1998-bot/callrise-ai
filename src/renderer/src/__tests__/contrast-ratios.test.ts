// M31 — WCAG contrast guard for index.css's token ramp, BOTH themes.
//
// Why this exists (BUG-133): the founder found the API Keys/Diagnostics
// pages "still looking off" in light mode even after every token reference
// was corrected (BUG-130/131). Investigating properly (not eyeballing)
// found the tokens all resolve correctly — the VALUES themselves are the
// problem. Computed directly: light-theme --color-surface sits at ~1.07:1
// contrast against --color-canvas, and --color-elevated/--color-line-soft
// are similarly close to --color-surface — all far below the 3:1 minimum
// WCAG sets for a perceivable UI-component boundary. Card backgrounds,
// borders, and nested "elevated" content are nearly invisible in light mode
// ACROSS THE WHOLE APP, not just the two screens that got clicked on.
//
// Deliberately NOT fixed by changing hex values here: color choices are a
// design decision (the founder's, per this milestone's own ground rules),
// and the whole light ramp is being rebuilt from scratch in Stage 4 for the
// First Light identity anyway — tuning the old indigo-era ramp now would be
// thrown-away work. This test's job is narrower and permanent: state the
// requirement as a measured, enforced fact, so "the new ramp passes
// contrast in both themes" is something Stage 4 proves before it ships, not
// something anyone has to remember to eyeball again.
//
// EXPECTED TO BE RED RIGHT NOW for several light-theme pairs — that is the
// point. A failing assertion here means "the known light-theme contrast
// bug (BUG-133) is still present," not "something broke." Stage 4 is done
// with this file when every assertion passes for its OWN chosen values,
// not when the file is deleted or skipped.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const INDEX_CSS = join(__dirname, '..', 'index.css')

type Ramp = Record<string, string>

/** Pulls every `--color-name: #hex;` declaration out of ONE @theme/`:root`
 *  block of index.css. `blockStart`/`blockEnd` are literal strings that
 *  bound the block, so dark (`:root {`) and light (`:root.light {`) never
 *  cross-contaminate even though both define the same token names. */
function parseRamp(css: string, blockStart: string, blockEnd: string): Ramp {
  const start = css.indexOf(blockStart)
  if (start === -1) throw new Error(`Could not find block start: ${blockStart}`)
  const end = css.indexOf(blockEnd, start)
  if (end === -1) throw new Error(`Could not find block end: ${blockEnd}`)
  const block = css.slice(start, end)
  const ramp: Ramp = {}
  for (const m of block.matchAll(/--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})[0-9a-fA-F]{0,2}\s*;/g)) {
    // Only the FIRST match per name wins (a ramp shouldn't redefine within
    // its own block; this also naturally ignores the base @theme block's
    // tokens leaking into a later block via a substring match).
    if (!(m[1] in ramp)) ramp[m[1]] = m[2]
  }
  return ramp
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function linearChannel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * linearChannel(r) + 0.7152 * linearChannel(g) + 0.0722 * linearChannel(b)
}

/** WCAG 2.x contrast ratio, 1:1 (identical) to 21:1 (black on white). */
function contrast(hexA: string, hexB: string): number {
  const l1 = relativeLuminance(hexA)
  const l2 = relativeLuminance(hexB)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

const TEXT_MIN = 4.5 // WCAG AA, normal-size text
const UI_MIN = 3.0 // WCAG AA, non-text UI component boundaries (SC 1.4.11)

/** Every (theme, kind, a, b) combination measured as failing on 2026-08-29,
 *  the day BUG-133 was found and this guard was written. Wrapped in
 *  `it.fails()` below instead of a plain failing `it()` so the suite stays
 *  green today (this is a KNOWN, tracked condition, not a fresh break) —
 *  but the moment any one of these starts passing on its own (e.g. Stage 4
 *  changes --color-surface's light value), `it.fails()` flips to reporting
 *  a FAILURE, because "still expected to fail" became false. That failure
 *  is the intended signal: it means this allowlist is now stale and must
 *  be edited — the pair either graduates to a plain `it()` (if Stage 4's
 *  new ramp is meant to fix it) or, if still deliberately out of scope,
 *  gets removed with a note why. The allowlist can only shrink by someone
 *  looking at it, never grow silently, so it can't rot into hiding a NEW
 *  regression the way a bare `.skip()` could.
 *
 *  IMPORTANT, found while writing this: dark theme ALSO fails several of
 *  these by this exact formula (surface-vs-canvas 1.08:1, elevated-vs-
 *  surface 1.07:1) even though every screenshot taken during M31 shows
 *  dark-mode cards reading fine by eye. This is a known, real limitation
 *  of the WCAG 2.1 relative-luminance formula specifically near the dark
 *  end of the luminance range (part of why WCAG's own successor work on
 *  APCA exists) — it is NOT license to lower the bar quietly. Reported
 *  plainly to the founder rather than resolved unilaterally: Stage 4 should
 *  decide whether dark mode's acceptance bar is this same WCAG 2.1 ratio
 *  (which would mean dark mode's already-shipping, already-fine-looking
 *  ramp also needs new values) or a different, perceptually-validated
 *  measure. Either way, the number is real and tracked here either way. */
const KNOWN_BUG_133_FAILURES = new Set([
  'dark|ui|surface|canvas',
  'dark|ui|elevated|surface',
  'dark|ui|line|surface',
  'dark|ui|line|canvas',
  'dark|ui|line-soft|surface',
  'light|text|warning|canvas',
  'light|text|accent|canvas',
  'light|ui|surface|canvas',
  'light|ui|elevated|surface',
  'light|ui|line|surface',
  'light|ui|line|canvas',
  'light|ui|line-soft|surface'
])

/** Text-on-background pairs that appear throughout the app (a label on a
 *  card, a status word on the page). 4.5:1 is the WCAG AA bar for normal
 *  text. `--color-faint`'s own comment in index.css already says "real 11px
 *  metadata, must clear AA" — this test is what actually enforces that
 *  claim instead of leaving it as an unverified comment. */
const TEXT_PAIRS: [fg: string, bg: string][] = [
  ['ink', 'canvas'],
  ['ink', 'surface'],
  ['ink', 'elevated'],
  ['muted', 'canvas'],
  ['muted', 'surface'],
  ['faint', 'canvas'],
  ['faint', 'surface'],
  ['positive', 'canvas'],
  ['warning', 'canvas'],
  ['danger', 'canvas'],
  ['accent', 'canvas']
]

/** Non-text UI boundaries — does a card, a border, or a raised surface
 *  actually read as a distinct shape against what's behind it? 3:1 is
 *  WCAG's own bar for this (SC 1.4.11 Non-text Contrast), not a number
 *  picked for this app specifically. */
const UI_PAIRS: [a: string, b: string][] = [
  ['surface', 'canvas'],
  ['elevated', 'surface'],
  ['line', 'surface'],
  ['line', 'canvas'],
  ['line-soft', 'surface']
]

function checkRamp(themeName: string, ramp: Ramp): void {
  describe(`${themeName} theme`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      const known = KNOWN_BUG_133_FAILURES.has(`${themeName}|text|${fg}|${bg}`)
      const runner = known ? it.fails : it
      runner(
        `text-${fg} on bg-${bg} clears ${TEXT_MIN}:1 (WCAG AA text)${known ? ' [BUG-133, tracked]' : ''}`,
        () => {
          const ratio = contrast(ramp[fg], ramp[bg])
          expect(
            ratio,
            `text-${fg} (${ramp[fg]}) on bg-${bg} (${ramp[bg]}) in ${themeName} theme is ${ratio.toFixed(2)}:1, below the ${TEXT_MIN}:1 WCAG AA minimum for text.`
          ).toBeGreaterThanOrEqual(TEXT_MIN)
        }
      )
    }

    for (const [a, b] of UI_PAIRS) {
      const known = KNOWN_BUG_133_FAILURES.has(`${themeName}|ui|${a}|${b}`)
      const runner = known ? it.fails : it
      runner(
        `${a} against ${b} clears ${UI_MIN}:1 (WCAG non-text UI boundary)${known ? ' [BUG-133, tracked]' : ''}`,
        () => {
          const ratio = contrast(ramp[a], ramp[b])
          expect(
            ratio,
            `--color-${a} (${ramp[a]}) against --color-${b} (${ramp[b]}) in ${themeName} theme is ${ratio.toFixed(2)}:1, below the ${UI_MIN}:1 WCAG minimum for a perceivable UI-component boundary (SC 1.4.11). See BUG-133.`
          ).toBeGreaterThanOrEqual(UI_MIN)
        }
      )
    }
  })
}

describe('WCAG contrast (BUG-133 guard)', () => {
  const css = readFileSync(INDEX_CSS, 'utf8')
  const dark = parseRamp(css, '@theme {', '\n}')
  const light = parseRamp(css, ':root.light {', '\n  }')

  it('parses real, non-empty ramps for both themes (sanity: the guard can see the tokens)', () => {
    expect(dark.canvas).toBeDefined()
    expect(dark.surface).toBeDefined()
    expect(light.canvas).toBeDefined()
    expect(light.surface).toBeDefined()
    // Dark and light must actually differ — if they don't, parseRamp fell
    // back to reading the wrong block and this test would pass for the
    // wrong reason (species-40 shaped: a real, reproducible check proving
    // the wrong thing).
    expect(dark.canvas).not.toBe(light.canvas)
  })

  checkRamp('dark', dark)
  checkRamp('light', light)
})
