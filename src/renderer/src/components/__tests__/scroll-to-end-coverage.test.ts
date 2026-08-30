import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The founder asked for a jump-to-bottom control on "every page that is long",
 * and to "find the rest of the pages that will need it".
 *
 * Enumerating long pages would be a list that goes stale the first time
 * someone writes a long page — the same failure as enumerating the brands on
 * the lettermark (species 51) or the files that route by category. So the
 * control is attached to the two places scrolling actually HAPPENS:
 *
 *   1. AppShell's main column — every ordinary screen scrolls inside it, so a
 *      new page inherits the control without knowing it exists.
 *   2. Full-bleed screens, which set `fullBleed` and own their own scroller.
 *      AppShell's column deliberately does NOT scroll for these, so it cannot
 *      host the button, and each must attach its own.
 *
 * (2) is the gap this test exists for: a new full-bleed screen would silently
 * have no control, and nothing would fail.
 */

const RENDERER = join(__dirname, '..', '..')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.tsx') && !full.includes('__tests__')) out.push(full)
  }
  return out
}

const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('the jump-to-bottom control reaches every scrollable surface', () => {
  it('AppShell hosts it for every ordinary page', () => {
    const shell = strip(readFileSync(join(RENDERER, 'app', 'AppShell.tsx'), 'utf8'))
    expect(shell).toContain('ScrollToEnd')
    // Must be tied to the element that actually scrolls, and skipped on
    // full-bleed where that element does not scroll.
    expect(shell).toMatch(/ref=\{mainScrollRef\}/)
    expect(shell).toMatch(/!fullBleed && <ScrollToEnd/)
  })

  it('every full-bleed screen attaches its own', () => {
    // A screen that opts out of AppShell's scrolling has taken responsibility
    // for it, including this.
    const offenders: string[] = []
    for (const file of walk(RENDERER)) {
      const code = strip(readFileSync(file, 'utf8'))
      // The prop is passed by the screen's caller, so look for the screens
      // that DECLARE their own vertical scroller at the page level.
      const ownsPageScroller = /className="relative flex-1[^"]*overflow-y-auto/.test(code)
      if (ownsPageScroller && !code.includes('ScrollToEnd')) {
        offenders.push(file.slice(file.indexOf('renderer')))
      }
    }
    expect(
      offenders,
      'these own a page-level scroller but have no jump-to-bottom control — attach <ScrollToEnd targetRef={...}/> to it'
    ).toEqual([])
  })

  it('nothing else hand-rolls a jump-to-end button', () => {
    // The past-call transcript had its own copy before this component existed,
    // and it is now gone. Two implementations drift, and the second one is
    // always the one nobody remembers to fix.
    //
    // TWO FILES ARE EXEMPT, and they are exempt for a reason rather than by
    // convenience — this test found them and they turned out not to be the
    // same feature at all:
    //
    //   AssistantView          — `nearBottomRef`, used to decide whether to
    //                            KEEP PINNING to the bottom as tokens stream
    //                            in. There is no button; it is auto-follow.
    //   live/TranscriptView    — `stickToBottom` + `caughtUp`, follow-the-tail
    //                            on a transcript that is still GROWING during
    //                            a call, with its own "jump to latest".
    //
    // Both track a moving end; ScrollToEnd jumps to a static one. Folding them
    // together would mean one component with two behaviours selected by a
    // flag, which is how a shared component becomes worse than two honest
    // ones. The tripwire still fires for a THIRD.
    const EXEMPT = new Set(['AssistantView.tsx', 'TranscriptView.tsx'])
    const hand: string[] = []
    for (const file of walk(RENDERER)) {
      if (file.endsWith('ScrollToEnd.tsx')) continue
      if (EXEMPT.has(file.split(/[\\/]/).pop() ?? '')) continue
      const code = strip(readFileSync(file, 'utf8'))
      if (/scrollHeight\s*-\s*\w+\.scrollTop\s*-\s*\w+\.clientHeight/.test(code)) {
        hand.push(file.slice(file.indexOf('renderer')))
      }
    }
    expect(
      hand,
      'these compute at-bottom by hand — use <ScrollToEnd>, or add an exemption here saying why it is a different behaviour'
    ).toEqual([])
  })
})
