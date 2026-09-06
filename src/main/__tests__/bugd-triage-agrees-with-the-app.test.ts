// M37 Stage 2 — the BUG-D triage instrument must not drift from the app.
//
// scripts/verification/bugd-triage.mjs decides whether a call's missing words
// are explained by capture failing or by something downstream. To do that it
// needs one rule the SHIPPED app also holds: the date from which the absence
// of a channel means anything (CHANNEL_ATTRIBUTION_SINCE). The instrument
// cannot import the renderer's module (it runs as a plain script over JSON
// files on any machine, with no build step), so it carries a copy — and a
// copy of a rule goes stale silently, which is species 16 on this project and
// has already cost it once.
//
// This is the cheapest possible guard: if the shipped constant moves and the
// instrument's does not, the suite says so by name. The sibling
// bugd-partition.mjs carries the same warning in its header and has no such
// test; it is left alone here rather than half-fixed.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')

// The app's constant is READ FROM ITS SOURCE rather than imported. Importing
// it pulls a renderer module into a main-process test, and the renderer's own
// `@renderer/...` path alias is not resolvable from the node tsconfig — the
// first version of this file failed typecheck with
// "Cannot find module '@renderer/features/coaching/types'", a transitive import
// of the file it wanted one string from. Reading the source is also closer to
// what this test is actually asserting: that two files agree textually.
function appConstant(): string {
  const src = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'features', 'calls', 'types.ts'), 'utf8')
  const m = /export const CHANNEL_ATTRIBUTION_SINCE = '([\d-]+)'/.exec(src)
  if (!m) throw new Error('the app no longer declares CHANNEL_ATTRIBUTION_SINCE in calls/types.ts')
  return m[1]
}

describe('bugd-triage.mjs mirrors the app', () => {
  it('carries the same CHANNEL_ATTRIBUTION_SINCE the shipped app uses', () => {
    const app = appConstant()
    const src = readFileSync(join(ROOT, 'scripts', 'verification', 'bugd-triage.mjs'), 'utf8')
    const m = /export const CHANNEL_ATTRIBUTION_SINCE = '([\d-]+)'/.exec(src)
    expect(m, 'the instrument no longer declares CHANNEL_ATTRIBUTION_SINCE — did it get renamed?').not.toBeNull()
    expect(
      m?.[1],
      `the app says ${app}, the triage instrument says ${m?.[1]}. ` +
        'One of them is wrong about which calls can be judged; update scripts/verification/bugd-triage.mjs.'
    ).toBe(app)
  })

  it('the collector never copies a transcript field out of a call record', () => {
    // The privacy claim in collect-bugd-evidence.ps1's header, as a test. It
    // reads `text` for exactly two things — a WORD COUNT and a gap's duration
    // — and must never place `text`, `title`, `summary`, `coaching`, `preview`
    // or `notes` into the output object. Enumerated against the collector's
    // source so a future edit that adds one is caught here rather than after
    // the file has already been sent somewhere.
    const ps = readFileSync(join(ROOT, 'scripts', 'verification', 'collect-bugd-evidence.ps1'), 'utf8')
    // the assignment lines inside the two [ordered]@{...} literals
    const assigned = [...ps.matchAll(/^\s{4,}(\w+)\s*=\s*(.+)$/gm)].map((x) => ({ key: x[1], value: x[2].trim() }))
    expect(assigned.length, 'no assignments found — did the collector change shape?').toBeGreaterThan(10)

    // Every assignment that READS a content-bearing field at all.
    const reads = assigned.filter((a) => /\$[cs]\.(text|title|summary|coaching|preview|notes)\b/.test(a.value))

    // …of which exactly three FORMS are safe, because none of them can carry a
    // word out: a word count, a gap's numeric duration, and a [bool] presence
    // flag. Anything else placed in the output would be content.
    const SAFE = [
      /^\$\(if \(\$s\.kind -eq 'gap'.*\[double\]\$Matches\[1\].*\)$/, // a gap's numeric duration
      /^\[bool\]\$c\.(summary|coaching)$/ // "there is one", never what it says
    ]
    const unsafe = reads.filter((r) => !SAFE.some((re) => re.test(r.value)))
    expect(
      unsafe.map((l) => `${l.key} = ${l.value}`),
      'the collector would copy transcript content into the evidence file'
    ).toEqual([])
    expect(reads.length, 'expected the gap duration and the two presence flags').toBe(3)

    // The word count is computed on its own line rather than inside the output
    // literal, so it is checked separately — and it must still be a COUNT.
    expect(
      /\$wordCount = \(\[regex\]::Matches\(\[string\]\$s\.text, '\\S\+'\)\)\.Count/.test(ps),
      'the word count is the whole point of reading text at all — it must still be a count'
    ).toBe(true)
    expect(assigned.some((a) => a.key === 'words' && a.value === '$wordCount'), 'words must be the count, nothing else').toBe(true)
    expect(assigned.some((a) => a.key === 'words'), 'the word COUNT is the point — it must still be collected').toBe(true)
  })
})
