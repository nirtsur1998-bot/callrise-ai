// Taxonomy species 12 — the thoroughly-tested frozen module. A file whose own
// header says it is FROZEN / no longer production code keeps a careful test
// suite, so "do we test this?" is answered with a confident yes while the
// production copy drifts untested. The mechanical tell: such a module must
// have NO production importer. If it does, either the header lies (the file
// IS production) or the import is a leak from the past — both are findings.
// Found live on 2026-09-06: live/segments.ts said "Nothing in the running app
// calls this file any more" while three production files imported speakerKey
// from it.
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const SRC = join(__dirname, '..')
// The declaration is the header's FIRST line — where a module says what it is.
// A later mention ("see the frozen oracle") is a reference, not a status.
const FROZEN_MARK = /^\s*(?:\/\/|\/\*+)\s*(?:FROZEN|RETIRED|DEAD CODE)/i

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n) && !n.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** The header = the leading comment block before the first import/statement. */
function header(text: string): string {
  const m = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*))+/.exec(text)
  return m ? m[0] : ''
}

const files = walk(SRC)
const isTest = (p: string): boolean => p.split(sep).includes('__tests__') || /\.test\.tsx?$/.test(p)
const frozen = files.filter((p) => !isTest(p) && FROZEN_MARK.test(header(readFileSync(p, 'utf8'))))

describe('a module that declares itself frozen has no production importer', () => {
  it('finds the frozen oracle so this test is not vacuous', () => {
    expect(frozen.map((p) => relative(SRC, p).replace(/\\/g, '/'))).toContain('renderer/src/features/live/segments.ts')
  })

  for (const mod of frozen) {
    const rel = relative(SRC, mod).replace(/\\/g, '/').replace(/\.tsx?$/, '')
    const base = rel.split('/').pop()!
    it(`${rel}: only tests import it`, () => {
      const importers = files
        .filter((p) => p !== mod && !isTest(p))
        .filter((p) => {
          const t = readFileSync(p, 'utf8')
          // any import path that ends in the module's basename, relative or aliased
          return new RegExp(`from ['"][^'"]*/${base}['"]`).test(t)
        })
        .map((p) => relative(SRC, p).replace(/\\/g, '/'))
      expect(importers, `production importers of a frozen module`).toEqual([])
    })
  }
})
