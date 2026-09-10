// @vitest-environment node
//
// M39 / BUG-268 — a Tailwind colour class naming a token that does not exist
// generates NO CSS and fails SILENTLY.
//
// `InterruptedCallPrompt.tsx` shipped `bg-warn-soft` and `text-warn` while the
// token is `--color-warning`. The result was an AlertTriangle rendered in
// default body text on a default background — a warning with no warning colour,
// for as long as it has existed. Nothing goes red, nothing throws, and a
// screenshot of it looks like a slightly plain card rather than a bug. I found
// it only because I was about to copy the same class names into a new
// component.
//
// This is the "installed guards not in the gate" lesson applied forward: the
// check exists as a TEST, so it runs, rather than as a note somebody remembers.
//
// SCOPE, stated honestly: it verifies the app's OWN semantic colour names, read
// from index.css at test time rather than hardcoded. It does not attempt to
// validate arbitrary Tailwind utilities, spacing, or built-in palette colours —
// a check that tried to would be a pattern net with an unmeasured escape rate,
// and this one is meant to be exact about a small thing instead.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(__dirname, '..', '..', '..')
const CSS = join(SRC, 'index.css')

/** Every `--color-<name>` the stylesheet actually defines. */
function definedColorTokens(): Set<string> {
  const css = readFileSync(CSS, 'utf8')
  const out = new Set<string>()
  for (const m of css.matchAll(/--color-([a-z0-9-]+)\s*:/g)) out.add(m[1])
  return out
}

function tsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) tsxFiles(full, acc)
    else if (entry.endsWith('.tsx')) acc.push(full)
  }
  return acc
}

describe('BUG-268 — a colour class must name a token that exists', () => {
  const tokens = definedColorTokens()

  it('index.css defines the tokens this check depends on', () => {
    // A guard whose input is empty passes everything. "produced no findings"
    // and "never ran" must not look the same.
    expect(tokens.size).toBeGreaterThan(10)
    expect(tokens.has('warning')).toBe(true)
    expect(tokens.has('warn')).toBe(false) // the whole reason this test exists
  })

  it('no component uses a semantic colour class with no matching token', () => {
    // Only the families this app defines semantically. A name outside this set
    // is a Tailwind built-in (red-500, white) or an arbitrary value, and not
    // this test's business.
    const SEMANTIC = /\b(?:text|bg|border|ring|from|to|via|fill|stroke|decoration|outline|shadow|accent|caret|divide)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/\d+)?\b/g
    // Only what is actually inside a className — the first version scanned raw
    // file text and reported four hits that were the words `text-warn` inside
    // THIS FIX'S OWN COMMENTS explaining the bug. A guard that flags the
    // documentation of the thing it guards against is noise.
    const CLASSNAMES = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g
    const offenders: string[] = []

    for (const file of tsxFiles(SRC)) {
      const src = readFileSync(file, 'utf8')
      const classText = [...src.matchAll(CLASSNAMES)]
        .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
        .join(' ')
      for (const m of classText.matchAll(SEMANTIC)) {
        const name = m[1]
        if (tokens.has(name)) continue
        // Tailwind's directional suffixes (border-t/-r/-b/-l/-x/-y/-s/-e) are
        // built-ins that happen to be one letter, and one letter is a prefix of
        // almost every token. Excluded by length, not by listing them.
        if (name.length < 3) continue
        // Only flag a name that is a PREFIX of a real token — that is the
        // typo shape ("warn" for "warning", "posit" for "positive"). Anything
        // else is a built-in or an unrelated utility and is out of scope.
        const looksLikeTypo = [...tokens].some((t) => t !== name && t.startsWith(name))
        if (looksLikeTypo) offenders.push(`${file.replace(SRC, '')}: ${m[0]}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
