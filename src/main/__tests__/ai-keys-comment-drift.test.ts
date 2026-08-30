// ai-keys.ts is a COMMENT-DRIFT HOTSPOT. Treat it as one.
//
// Three separate comments in this one file described intent while the code did
// something narrower, all found in a single session (2026-08-30):
//
//   1. maybeAutoSelectProvider's header said it fires when "the selected
//      provider has no working key". The code checked PRESENCE. That gap was
//      BUG-143: a rejected key both won the default and was then protected from
//      being replaced by a good one.
//   2. deriveStatusDot's comment (ApiKeysSection.tsx) said a saved-but-invalid
//      key "just shows Connected ... same limitation M16 already had" —
//      documented, accepted, inherited, and never re-read. It was an honest
//      note when written and became the bug's hiding place. Species 16: the
//      finding that was already written down.
//   3. The BUG-143 fix's own header claimed validation "runs after the
//      'already working' early return, so an install with a working provider
//      never pays for it" — true for about an hour, then false, and the
//      founder found the consequence by hand.
//
// **Any future work in ai-keys.ts starts by checking whether the comments still
// describe the code.** They demonstrably drift here faster than anywhere else
// in this repo.
//
// THIS FILE EXISTS BECAUSE A MARKER IS NOT ENOUGH. "Change this comment in the
// same edit" is a note asking the next person to be careful, and the three
// entries above are what happens to such notes. The claim below is instead
// COUPLED to the code that makes it true, so changing the behaviour without
// changing the sentence turns a test red.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, '..', 'ai-keys.ts'), 'utf8')

/** The file with comment markers and line wrapping flattened, so a claim can be
 *  searched for as a sentence rather than as bytes. The first draft of this test
 *  searched SRC directly and failed on its own target — the sentence was split
 *  across two comment lines. A guard that breaks when someone re-wraps a
 *  paragraph would be abandoned within a week, which makes it worse than none. */
const PROSE = SRC.replace(/\n\s*\*\s?/g, ' ').replace(/\s+/g, ' ')

/** The function body, from its signature to the closing brace at column 0. */
function bodyOf(name: string): string {
  const start = SRC.indexOf(`async function ${name}(`)
  expect(start, `${name} not found — did it get renamed?`).toBeGreaterThan(-1)
  const end = SRC.indexOf('\n}', start)
  expect(end, `could not find the end of ${name}`).toBeGreaterThan(start)
  return SRC.slice(start, end)
}

describe('ai-keys.ts: the doc comment cannot quietly stop being true', () => {
  const CLAIM = 'every text-AI key save validates, always'

  it('the comment still makes the claim this test pins', () => {
    // If someone DELIBERATELY narrows the behaviour, they delete this sentence
    // and this test tells them the coupled check below is now theirs to remove
    // too. That is a conscious change. Silent drift is what is being prevented.
    expect(
      PROSE.includes(CLAIM),
      `The sentence "${CLAIM}" is gone from ai-keys.ts. If validation was ` +
        'deliberately narrowed, delete this whole test file and say so in the ' +
        'commit. If the sentence was just reworded, restore the phrase — it is ' +
        'load-bearing for the check below.'
    ).toBe(true)
  })

  it('...and nothing returns before the validation that makes it true', () => {
    // THE COUPLING. The claim is "always". The way it silently becomes false is
    // exactly how it became false the first time: an early return added between
    // the providerId guard and the probe, so the ordinary path (you already
    // have a working default, you paste another key) validates nothing.
    const body = bodyOf('validateAndMaybeAutoSelect')
    const guardEnd = body.indexOf('if (!providerId) return {}')
    const probe = body.indexOf('validateKey(')
    expect(guardEnd, 'the providerId guard moved or changed shape').toBeGreaterThan(-1)
    expect(probe, 'validateKey is no longer called here').toBeGreaterThan(guardEnd)

    const between = body.slice(guardEnd + 'if (!providerId) return {}'.length, probe)
    const earlyReturns = between.split('\n').filter((l) => /^\s*(if\s*\(.*\)\s*)?return\b/.test(l))
    expect(
      earlyReturns,
      'Something returns BEFORE validateKey, so the save no longer validates ' +
        `"always" — but the comment still says it does. That is the exact ` +
        'shape of BUG-143 and of the two comment drifts before it. Either ' +
        'remove the early return, or change the sentence and this test together.'
    ).toEqual([])
  })

  it('auto-selection cannot happen without a validated key', () => {
    // The other half of BUG-143: a key becoming the default on the strength of
    // having been SAVED rather than having WORKED.
    const body = bodyOf('validateAndMaybeAutoSelect')
    const save = body.indexOf('saveAppSettings(')
    expect(save, 'the auto-select write moved').toBeGreaterThan(-1)
    const guard = body.slice(0, save)
    expect(
      /keyValidated\s*&&/.test(guard),
      'saveAppSettings is reached without keyValidated gating it — a key could ' +
        'become the default again without having been shown to work.'
    ).toBe(true)
  })
})
