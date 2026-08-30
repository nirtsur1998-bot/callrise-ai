import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * An EXPIRY for the lettermark policy, not a reminder — taxonomy species 51.
 *
 * `SOURCES.md` says Groq, Cerebras and Z.ai have no CC0 mark, so they render
 * the designed lettermark instead. That was true when it was checked. It is a
 * claim about a THIRD PARTY'S library, which changes without telling us, and
 * the doc's own "re-check if Simple Icons adds these later" note sat unread
 * for a month while Claude and Hugging Face — never checked at all — rendered
 * lettermarks despite having had marks the whole time. The founder spotted
 * that on screen, which is the wrong place for it to surface.
 *
 * A re-check that depends on someone choosing to do it is not a control. So
 * this test fails once the recorded check has aged out, and tells you exactly
 * what to run. Fixing it is two minutes: re-run the curl, bump the date, and
 * if a brand has gained a mark, drop the SVG in.
 *
 * IF YOU ARE HERE BECAUSE THIS WENT RED: that is the test working, not
 * breaking. Do not extend the date without actually re-running the check —
 * a bumped date with no check behind it is the exact false claim this exists
 * to prevent, and it is worse than no expiry at all, because it now carries
 * a fresh date.
 */

const SOURCES = join(
  __dirname,
  '..',
  '..',
  'assets',
  'model-logos',
  'SOURCES.md'
)

/** Machine-readable so this test and the prose cannot disagree. */
const RECHECK_RE = /<!--\s*LETTERMARK-RECHECK-BY:\s*(\d{4}-\d{2}-\d{2})\s*-->/
const SLUGS_RE = /<!--\s*LETTERMARK-SLUGS:\s*([a-z0-9,\s-]+?)\s*-->/

describe('the lettermark policy carries a live expiry, not a stale note', () => {
  const doc = readFileSync(SOURCES, 'utf8')

  it('records a re-check date and the slugs the claim covers', () => {
    expect(doc, 'SOURCES.md has no LETTERMARK-RECHECK-BY marker').toMatch(RECHECK_RE)
    expect(doc, 'SOURCES.md has no LETTERMARK-SLUGS marker').toMatch(SLUGS_RE)
  })

  it('has not aged out', () => {
    const by = doc.match(RECHECK_RE)![1]
    const slugs = doc.match(SLUGS_RE)![1].split(',').map((x) => x.trim())
    const expired = new Date().toISOString().slice(0, 10) > by
    expect(
      expired,
      [
        ``,
        `The lettermark policy's evidence expired on ${by}.`,
        ``,
        `Re-check EVERY brand still on the lettermark, not just one — species 51:`,
        ``,
        slugs
          .map(
            (s) =>
              `  curl -s -o /dev/null -w "%{http_code}\\n" https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${s}.svg`
          )
          .join('\n'),
        ``,
        `404 = still absent, keep the lettermark. 200 = a mark now exists:`,
        `fetch it, append fill="currentColor" width="100%" height="100%" to the`,
        `opening <svg> tag, add a row to the table, and wire it up.`,
        ``,
        `Then move LETTERMARK-RECHECK-BY forward. Do not move it without`,
        `running the check — that is the false claim this guard exists for.`,
        ``
      ].join('\n')
    ).toBe(false)
  })

  it('the recorded slugs match everything actually on the lettermark', () => {
    // Otherwise the expiry could keep checking a brand we already fixed while
    // silently ignoring one we added — the same "true for some, unchecked for
    // others" shape that caused species 51 in the first place.
    //
    // A lettermark is reachable TWO ways, and the first draft of this test
    // checked only one of them, which is how it found its own blind spot on
    // the very first run:
    //   1. a ModelBrand with no entry in BRAND_SVG          -> Z.ai
    //   2. a key card passing { label } with no `mark`      -> Groq, Cerebras
    // Groq and Cerebras are not ModelBrand members at all — they are
    // providers, and providers reach ModelLogo through the escape hatch. A
    // check that only read ModelLogo.tsx would have declared the policy fully
    // covered while two of its three subjects were invisible to it.
    const logo = readFileSync(join(__dirname, '..', 'ModelLogo.tsx'), 'utf8')
    const brandMap = logo.slice(logo.indexOf('const BRAND_SVG'), logo.indexOf('const BRAND_LABEL'))
    const labelMap = logo.slice(
      logo.indexOf('const BRAND_LABEL'),
      logo.indexOf('export interface ModelLogoProps')
    )
    const withMark = new Set([...brandMap.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1]))
    const fromBrands = [...labelMap.matchAll(/^\s{2}([a-z]+):/gm)]
      .map((m) => m[1])
      .filter((b) => !withMark.has(b))

    // `brand: { label: 'X' }` with no `mark:` on the same line is a lettermark.
    const cards = readFileSync(
      join(__dirname, '..', '..', 'features', 'settings', 'ApiKeysSection.tsx'),
      'utf8'
    )
    const fromCards = [...cards.matchAll(/brand:\s*\{\s*label:\s*'([^']+)'\s*\}/g)].map((m) => m[1])

    const onLettermark = [...fromBrands, ...fromCards]
      // The doc records Simple Icons SLUGS; these are our own display names.
      // An explicit map, never a fuzzy match: if a name ever stops mapping
      // cleanly, this should fail loudly rather than quietly not matching.
      .map((b) => b.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .sort()

    const slugs = doc
      .match(SLUGS_RE)![1]
      .split(',')
      .map((x) => x.trim())
      .sort()

    expect(
      onLettermark,
      'something renders as a lettermark but is not covered by the expiry re-check'
    ).toEqual(slugs)
  })
})
