import { describe, it, expect } from 'vitest'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * BUG-140 / taxonomy species 48 — a test file that is never run and does not
 * say so.
 *
 * This project's vitest `include` is `['src/**\/*.test.ts']`. A `.test.tsx` —
 * the natural filename for a component test — does not match it, is **skipped
 * in silence**, and the suite stays green. No warning, no "0 tests in this
 * file", nothing in the summary. The author, the reviewer and every later
 * session believe the behaviour is covered.
 *
 * That happened here: `EmptyState.test.tsx` was written during M31 Stage 3 and
 * was never collected. It surfaced only because I happened to run that one
 * file directly, where vitest says `No test files found`. In a full-suite run
 * it would have contributed exactly nothing and reported exactly nothing,
 * forever.
 *
 * This is the cheap half of the fix: it does not make component tests
 * possible (that needs React Testing Library and a DOM environment — see
 * BUG-140), but it makes writing one and NOT NOTICING impossible. The
 * expensive half can wait; being silently wrong should not.
 *
 * If this fails, you have two honest options and one dishonest one:
 *   • move the assertions into a plain `.ts` (what Stage 3 did — the rules go
 *     in `emptyStatePolicy.ts`, the `.tsx` stays presentation), or
 *   • do the real fix: add RTL + `environment: 'happy-dom'` and widen
 *     `include` to `src/**\/*.test.@(ts|tsx)`.
 * Deleting this test is the dishonest one.
 */

const SRC = join(__dirname, '..')
const CONFIG = join(__dirname, '..', '..', 'vitest.config.ts')

/** Every file under src/ whose name looks like a test the runner might miss. */
function findTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) findTestFiles(full, out)
    else if (/\.(test|spec)\.[a-z]+$/i.test(entry)) out.push(full)
  }
  return out
}

describe('no test file is silently uncollected (BUG-140)', () => {
  const config = readFileSync(CONFIG, 'utf8')

  it('the include pattern this test reasons about is still the one in use', () => {
    // Pins the premise. If someone widens `include` to cover .tsx, this fails
    // and whoever did it deletes this whole file on purpose rather than
    // leaving a guard that quietly guards nothing (species 47's shape).
    expect(config).toContain("include: ['src/**/*.test.ts']")
  })

  it('finds no test file the runner would skip in silence', () => {
    const all = findTestFiles(SRC)
    // Sanity: if the walk finds nothing, this test is vacuous and would pass
    // for the wrong reason — the exact failure it exists to prevent.
    expect(all.length, 'the walk found no test files at all — it is broken').toBeGreaterThan(50)

    const uncollected = all
      .filter((f) => !f.endsWith('.test.ts'))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))

    expect(
      uncollected,
      `these files LOOK like tests and are never run:\n  ${uncollected.join('\n  ')}\n` +
        `vitest's include is 'src/**/*.test.ts' — anything else is skipped without a word.`
    ).toEqual([])
  })
})
