// BUG-236 — "is this call really gone?", and the correction that only showed
// up because the fix was rehearsed on a copy of a real store before shipping.
//
// THE FIRST VERSION USED existsSync ALONE, and it was wrong in the most
// expensive possible direction. Deleting a call leaves a TOMBSTONE: the file
// stays on disk carrying `deleted: true`, and listCalls excludes it by design.
// So "the file exists" was true for all 25 of the founder's legitimately
// deleted calls — the check would have rescued every one of them, refused
// every redaction, and quietly undone BUG-215 in the name of protecting it.
//
// Measured on a copy of that store: rescue count 25, genuinely-gone 0. The
// correct answer for that store is rescue 0, genuinely-gone 25.
//
// Three outcomes, and the middle one is the correction:
//   no file                        -> gone
//   a file saying deleted: true    -> gone   (the tombstone)
//   a file that is neither, or is
//   unreadable                     -> NOT gone (the protected case)
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCallGoneFromDisk } from '../memory-runtime'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'calls-gone-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (id: string, body: unknown): void =>
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(body), 'utf8')

describe('isCallGoneFromDisk', () => {
  it('a call with no file at all is gone', () => {
    expect(isCallGoneFromDisk(dir, 'never-existed')).toBe(true)
  })

  it('A TOMBSTONE IS GONE — the case the first version got wrong', () => {
    // This is what deleting a call actually leaves behind. Treating it as
    // "still here" refuses the redaction that deleting the call promised.
    write('deleted-1', { id: 'deleted-1', deleted: true })
    expect(isCallGoneFromDisk(dir, 'deleted-1')).toBe(true)
  })

  it('a live call is NOT gone', () => {
    write('live-1', { id: 'live-1', title: 'Kevin — Renewal' })
    expect(isCallGoneFromDisk(dir, 'live-1')).toBe(false)
  })

  it('deleted: false is not gone either', () => {
    write('live-2', { id: 'live-2', deleted: false })
    expect(isCallGoneFromDisk(dir, 'live-2')).toBe(false)
  })

  it('AN UNREADABLE FILE IS NOT GONE — the whole point of the check', () => {
    // The protected case: listCalls swallows a parse failure and returns
    // nothing for this call, which used to be indistinguishable from deletion.
    // "I could not read it" is not evidence of deletion.
    writeFileSync(join(dir, 'corrupt-1.json'), '{ this is not json', 'utf8')
    expect(isCallGoneFromDisk(dir, 'corrupt-1')).toBe(false)
  })

  it('a truthy-but-not-true deleted value is not a tombstone', () => {
    // Strict === true. A tampered or half-written file must not be able to
    // talk this function into destroying quotes.
    write('odd-1', { id: 'odd-1', deleted: 'yes' })
    expect(isCallGoneFromDisk(dir, 'odd-1')).toBe(false)
    write('odd-2', { id: 'odd-2', deleted: 1 })
    expect(isCallGoneFromDisk(dir, 'odd-2')).toBe(false)
  })

  it('an empty file is not gone', () => {
    writeFileSync(join(dir, 'empty-1.json'), '', 'utf8')
    expect(isCallGoneFromDisk(dir, 'empty-1')).toBe(false)
  })

  it('reproduces the real store: 25 tombstones are gone, a locked live call is not', () => {
    // The shape the rehearsal measured, in miniature. All 25 of the founder's
    // orphaned ids had files; every one was a tombstone. The first version
    // called them all "still here".
    for (let i = 0; i < 25; i++) write(`tomb-${i}`, { id: `tomb-${i}`, deleted: true })
    write('locked', { id: 'locked', title: 'still a real call' })

    const gone = Array.from({ length: 25 }, (_, i) => isCallGoneFromDisk(dir, `tomb-${i}`))
    expect(gone.every(Boolean), 'a tombstone was treated as a live call').toBe(true)
    expect(isCallGoneFromDisk(dir, 'locked')).toBe(false)
  })
})
