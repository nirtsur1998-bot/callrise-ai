// M31 Stage 1 — every color-token utility class used in the renderer must
// reference a token that actually exists in index.css's @theme block.
//
// Why this exists (BUG-130): Tailwind v4 emits NO CSS RULE AT ALL for a
// utility whose token is undefined — `bg-surface-2` with no --color-surface-2
// silently renders as "no background", with no build error and no runtime
// warning. Four files shipped that way (the telemetry section and three Home
// notice cards used an fg-1/2/3 + surface-1/2 naming scheme that was never
// added to @theme). A rename inside the token file, or a typo at a call site,
// would ship the same invisible way. This test greps the real source tree so
// the drift class fails CI instead of shipping.
//
// Scope is deliberately narrow: only class names inside OUR token families
// (canvas/surface/elevated/ink/muted/faint/line/accent/positive/warning/
// danger/speaker/track/fg) are checked, so Tailwind's own utilities
// (text-sm, border-t, bg-black/50…) can never false-positive.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const RENDERER_SRC = join(__dirname, '..')
const INDEX_CSS = join(RENDERER_SRC, 'index.css')

/** Token families this test polices. A class like `bg-surface-2` parses to
 *  token name `surface-2`; families not listed here are ignored entirely. */
const FAMILIES = [
  'canvas',
  'surface',
  'elevated',
  'ink',
  'muted',
  'faint',
  'line',
  'accent',
  'positive',
  'warning',
  'danger',
  'speaker',
  'track',
  'fg'
]

/** Utility prefixes that consume a color token in Tailwind. */
const PREFIXES = ['bg', 'text', 'border', 'ring', 'outline', 'fill', 'stroke', 'decoration', 'divide', 'shadow']

function definedColorTokens(): Set<string> {
  const css = readFileSync(INDEX_CSS, 'utf8')
  const names = new Set<string>()
  for (const m of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) {
    names.add(m[1])
  }
  return names
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue
      sourceFiles(full, out)
    } else if (/\.(tsx|ts)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

const FAMILY_ALT = FAMILIES.join('|')
const PREFIX_ALT = PREFIXES.join('|')
// Matches e.g. bg-surface, text-fg-2, border-line-soft, hover:bg-accent-soft,
// text-ink/80 — captures the token name after the utility prefix. The name
// must start with a family word at a hyphen boundary.
const CLASS_RE = new RegExp(`(?:^|[^a-zA-Z0-9-])(?:${PREFIX_ALT})-((?:${FAMILY_ALT})(?:-[a-z0-9]+)*)(?:/\\d+)?(?![a-zA-Z0-9-])`, 'g')

describe('color-token integrity (BUG-130 guard)', () => {
  const defined = definedColorTokens()

  it('parses a real token set out of index.css (sanity: the guard can see the theme)', () => {
    // If this ever fails, the test went blind — it must never "pass" by
    // matching zero tokens against zero usages.
    expect(defined.has('surface')).toBe(true)
    expect(defined.has('ink')).toBe(true)
    expect(defined.has('accent')).toBe(true)
    expect(defined.size).toBeGreaterThanOrEqual(15)
  })

  it('every token-family utility class in the renderer refers to a defined token', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(RENDERER_SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(CLASS_RE)) {
        const token = m[1]
        if (!defined.has(token)) {
          const line = text.slice(0, m.index).split('\n').length
          offenders.push(`${relative(RENDERER_SRC, file)}:${line} → ${token}`)
        }
      }
    }
    expect(
      offenders,
      `These classes reference color tokens that do not exist in index.css @theme — Tailwind emits no CSS for them, so they render unstyled:\n${offenders.join('\n')}`
    ).toEqual([])
  })
})
