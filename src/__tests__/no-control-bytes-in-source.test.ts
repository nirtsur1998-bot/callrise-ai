// Taxonomy species 70 — the backslash that did not survive the journey. A
// regex written through a shell heredoc arrived with `\b` turned into a
// literal BACKSPACE byte (0x08); the pattern could never match, no tool
// complained, and only a vacuity guard in the test it lived in caught it
// (2026-09-06, frozen-modules-have-no-production-callers.test.ts's first
// draft). Control bytes have no business in source: this scans every source
// file for them and names the file, line and byte.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const DIRS = ['src', 'scripts', '.github']
const EXT = /\.(ts|tsx|mjs|cjs|js|json|yml|yaml|md|ps1)$/
// allowed: tab (0x09), LF (0x0A), CR (0x0D); everything else below 0x20, and 0x7F
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === 'out' || n === 'out-sandbox' || n === 'dist') continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXT.test(n)) out.push(p)
  }
  return out
}

describe('no control bytes in source', () => {
  const files = DIRS.flatMap((d) => walk(join(ROOT, d)))
  it('scans a non-trivial number of files (not vacuous)', () => {
    expect(files.length).toBeGreaterThan(200)
  })
  it('finds none', () => {
    const hits: string[] = []
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((l, i) => {
        const m = CONTROL.exec(l)
        if (m) hits.push(`${relative(ROOT, f).replace(/\\/g, '/')}:${i + 1} byte 0x${m[0].charCodeAt(0).toString(16).padStart(2, '0')}`)
      })
    }
    expect(hits).toEqual([])
  })
})
