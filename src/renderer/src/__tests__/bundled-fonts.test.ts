import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import config from '../../../../electron.vite.config'

/**
 * M31 Stage 4 — the type half.
 *
 * Three separate things can silently undo a bundled typeface, and all three
 * fail the same way: the app keeps rendering, just in the OS default face.
 * That is precisely the failure this stage exists to fix (the old stack named
 * 'Inter' and never bundled it, so Windows quietly served Segoe UI for
 * months), so each one gets a check rather than a comment.
 */

const ROOT = join(__dirname, '..', '..', '..', '..')
const INDEX_CSS = join(__dirname, '..', 'index.css')
const MAIN_TSX = join(__dirname, '..', 'main.tsx')
const PKG = join(ROOT, 'package.json')

// The families we actually ship. Both SIL OFL 1.1 — the licence that permits
// bundling and redistribution. See docs/M31-typeface-license.md for why this
// is deliberately not Satoshi (ITF Free Font License, which does not clearly
// permit shipping the file inside a distributed app).
const BUNDLED = [
  { pkg: '@fontsource-variable/manrope', family: 'Manrope Variable' },
  { pkg: '@fontsource-variable/geist-mono', family: 'Geist Mono Variable' }
]

describe('bundled typefaces (M31 Stage 4)', () => {
  const css = readFileSync(INDEX_CSS, 'utf8')
  const main = readFileSync(MAIN_TSX, 'utf8')
  const pkg = JSON.parse(readFileSync(PKG, 'utf8')) as {
    dependencies?: Record<string, string>
  }

  for (const { pkg: name, family } of BUNDLED) {
    // A font named in --font-sans/--font-mono but never imported is exactly
    // the 'Inter' bug: the stack silently falls through to the next entry and
    // everyone sees the system face.
    it(`${family} is both declared in the theme AND imported`, () => {
      expect(css, `--font-sans/--font-mono never names '${family}'`).toContain(`'${family}'`)
      expect(main, `${name} is never imported, so its @font-face never exists`).toContain(name)
      expect(pkg.dependencies?.[name], `${name} is not a dependency`).toBeDefined()
    })

    // OFL requires the notice to travel with the font. It does — inside the
    // package — but only while the package is actually installed.
    it(`${family} ships its OFL licence file`, () => {
      expect(existsSync(join(ROOT, 'node_modules', name, 'LICENSE'))).toBe(true)
    })
  }

  it('never names a font it does not bundle', () => {
    // The specific regression: 'Inter' sat in --font-sans for the whole life
    // of the app and was never installed, so the real shipped typeface was
    // whatever the OS substituted. Any future addition to the stack has to be
    // either bundled or a genuine system fallback.
    const SYSTEM_FALLBACKS = new Set([
      '-apple-system',
      'BlinkMacSystemFont',
      'Segoe UI',
      'system-ui',
      'sans-serif',
      'ui-monospace',
      'SFMono-Regular',
      'Menlo',
      'Monaco',
      'Consolas',
      'Liberation Mono',
      'Courier New',
      'monospace'
    ])
    const bundledFamilies = new Set(BUNDLED.map((b) => b.family))

    const stacks = [...css.matchAll(/--font-(?:sans|mono):([^;]+);/g)].map((m) => m[1])
    expect(stacks.length, 'no --font-sans/--font-mono found — did the tokens move?').toBe(2)

    for (const stack of stacks) {
      for (const raw of stack.split(',')) {
        const face = raw.trim().replace(/^['"]|['"]$/g, '')
        if (!face || face.startsWith('/*')) continue
        expect(
          bundledFamilies.has(face) || SYSTEM_FALLBACKS.has(face),
          `'${face}' is named in a font stack but is neither bundled nor a system fallback — ` +
            `this is the 'Inter' bug: it will silently resolve to something else.`
        ).toBe(true)
      }
    }
  })

  it('keeps every font out of the inline-as-data-URI path', () => {
    // Small woff2 subsets (Manrope's cyrillic-ext is ~3KB) fall under Vite's
    // 4KB default and get inlined as url(data:font/woff2;base64,...). The meta
    // CSP in renderer/index.html declares no font-src, so it inherits
    // default-src 'self', which does NOT permit data: — and the strictest of
    // the two policies wins, so the response header allowing data: is not a
    // rescue. An inlined font is a blocked font, and a blocked font is a
    // silent fallback. Found by building and reading the output.
    const limit = (config as { renderer?: { build?: { assetsInlineLimit?: unknown } } }).renderer
      ?.build?.assetsInlineLimit
    expect(typeof limit, 'assetsInlineLimit is no longer a predicate function').toBe('function')

    const predicate = limit as (filePath: string) => boolean | undefined
    for (const f of [
      'assets/manrope-cyrillic-ext-wght-normal.woff2',
      'assets/geist-mono-latin-wght-normal.woff2',
      'some/path/font.woff',
      'some/path/font.otf',
      'some/path/font.ttf'
    ]) {
      expect(predicate(f), `${f} would be inlined as a data: URI and blocked by the CSP`).toBe(
        false
      )
    }
    // The AudioWorklet exclusion this predicate already existed for must survive.
    expect(predicate('assets/pcm-processor.js')).toBe(false)
    // And ordinary assets must still be free to inline.
    expect(predicate('assets/tiny-icon.svg')).toBeUndefined()
  })
})
