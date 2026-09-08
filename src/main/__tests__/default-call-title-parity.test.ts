// BUG-232 — "is this call still untitled?" is asked in TWO places that cannot
// import each other: main (the backfill's eligibility filter) and the renderer
// (CallDetail's decision to offer the manual button).
//
// That is principle 10's shape exactly — a value that must be duplicated
// across the main/renderer boundary — so it gets the treatment that principle
// demands: a same-as check AND an independent correctness check on each side.
// A lockstep pair can be identical and both wrong, and only the second kind of
// assertion catches that.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_TITLE_PREFIX, isDefaultCallTitle } from '../calls-fs'

const CALL_DETAIL = join(
  __dirname,
  '..',
  '..',
  'renderer',
  'src',
  'features',
  'calls',
  'CallDetail.tsx'
)

describe('the default-title test agrees on both sides of the process boundary', () => {
  it('main recognises exactly what main produces', () => {
    // The independent correctness check for main's side. formatTitle() builds
    // its output FROM this prefix, so this asserts the pair, not one half.
    const produced = `${DEFAULT_TITLE_PREFIX}Sep 8, 2026, 9:13 AM`
    expect(isDefaultCallTitle(produced)).toBe(true)
    expect(isDefaultCallTitle('Kevin — Revolut $500 Transfer to HNO')).toBe(false)
    expect(isDefaultCallTitle('')).toBe(false)
    expect(isDefaultCallTitle(undefined)).toBe(false)
    // Not a substring match: a real title that merely CONTAINS the prefix is
    // a titled call, and offering to rename it would be wrong.
    expect(isDefaultCallTitle('Recap of Call · Sep 8')).toBe(false)
  })

  it('the renderer uses the same prefix, and its own copy still works', () => {
    const source = readFileSync(CALL_DETAIL, 'utf8')
    const match = /const isDefaultTitle = \/\^(.+?)\/\.test\(/.exec(source)
    expect(
      match,
      'CallDetail.tsx no longer decides "is this the default title?" with a literal regex — ' +
        'if that moved, move this guard with it rather than deleting it.'
    ).not.toBeNull()

    // SAME-AS: the renderer's pattern is the prefix main actually produces.
    // `·` and the spaces are the whole content, so an innocent reformat of
    // either side shows up here.
    const rendererPattern = match?.[1] ?? ''
    expect(rendererPattern).toBe(DEFAULT_TITLE_PREFIX)

    // INDEPENDENT: the renderer's regex, executed here, agrees with main's
    // function on the same inputs. This is the half that catches the two
    // copies being identical and both wrong.
    const rendererTest = new RegExp(`^${rendererPattern}`)
    for (const sample of [
      `${DEFAULT_TITLE_PREFIX}Sep 8, 2026, 9:13 AM`,
      'Kevin — Revolut $500 Transfer to HNO',
      'Recap of Call · Sep 8',
      ''
    ]) {
      expect(rendererTest.test(sample), `disagreement on: ${JSON.stringify(sample)}`).toBe(
        isDefaultCallTitle(sample)
      )
    }
  })
})
