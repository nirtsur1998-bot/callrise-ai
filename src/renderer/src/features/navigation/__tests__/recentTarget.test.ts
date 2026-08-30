import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { recentTarget } from '../recentTarget'
import { OLD_TO_HUB, OLD_TO_HUB_TAB } from '../nav-items'
import type { RecentItem, RecentKind } from '@renderer/lib/recentlyViewed'

/**
 * Founder-reported, on a surface they use every session: clicking a call in
 * the sidebar's RECENT trail opened a live-call screen instead of that call.
 *
 * Two separate defects stacked, with different ages — worth keeping straight,
 * because only one of them is M31's:
 *
 *   1. SHIPPED (pre-dates M31, commit 7a2fac9). The destination came from a
 *      Record<RecentKind, NavId>: derived from the item's CATEGORY, so every
 *      call row went to the same place and the item's own id was never read.
 *   2. NEW in M31 Stage 2 (commit 905b3a3). OLD_TO_HUB redirects 'past-calls'
 *      into the Calls hub but carried no tab, so it landed on Live — which is
 *      also why Home's "Calls today" and "Tasks due" cards went to the wrong
 *      tab. Same root cause, three symptoms.
 *
 * The founder's requirement for this test was specific: assert that each item
 * type opens the ACTUAL RECORD, not merely that navigation was called.
 * "Clicking is not verified by having issued it."
 */

const item = (kind: RecentKind, id: string): RecentItem => ({
  kind,
  id,
  label: `${kind} ${id}`,
  viewedAt: '2026-08-30T10:00:00.000Z'
})

const KINDS: RecentKind[] = ['call', 'contact', 'deal']

describe('a recent row opens the record, not its category', () => {
  it.each(KINDS)('%s: the target carries the item id', (kind) => {
    // The assertion the old implementation could not have passed: its return
    // value did not contain the id at all.
    expect(recentTarget(item(kind, 'record-42')).id).toBe('record-42')
  })

  it.each(KINDS)('%s: two different records give two different targets', (kind) => {
    // THE test. Under the category-keyed table these were identical for every
    // item of a kind — which is precisely what "goes somewhere plausible but
    // wrong" means. If this ever passes trivially again, the regression is
    // back.
    const a = recentTarget(item(kind, 'aaa'))
    const b = recentTarget(item(kind, 'bbb'))
    expect(a).not.toEqual(b)
    expect(a.id).not.toBe(b.id)
  })

  it('sends each kind to the slot that actually opens that record', () => {
    // Contacts and deals share a screen, so the screen alone cannot say which
    // record to open — the slot is what disambiguates them, and conflating
    // them would reintroduce the bug for one of the two.
    expect(recentTarget(item('call', 'c1'))).toEqual({
      nav: 'past-calls',
      slot: 'call',
      id: 'c1'
    })
    expect(recentTarget(item('contact', 'p1'))).toEqual({
      nav: 'crm',
      slot: 'contact',
      id: 'p1'
    })
    expect(recentTarget(item('deal', 'd1'))).toEqual({ nav: 'crm', slot: 'deal', id: 'd1' })
  })

  it('every recent kind is handled — no silent fallthrough', () => {
    for (const kind of KINDS) {
      const t = recentTarget(item(kind, 'x'))
      expect(t.nav, `${kind} has no destination`).toBeTruthy()
      expect(t.slot, `${kind} has no record slot`).toBeTruthy()
    }
  })
})

describe('nothing in the renderer routes a record by its category', () => {
  // The founder's actual requirement was broader than the reported bug:
  // "make sure this doesn't happen anywhere else in the app silently."
  //
  // A hand sweep DID find a second instance — CommandPalette.tsx had a
  // byte-identical Record<RecentKind, NavId>, and its comment justified it by
  // saying deep-linking "would need MainApp to accept an initial record id",
  // which MainApp already did and which that very component already used for
  // its search results, twenty lines away.
  //
  // But a sweep I ran once only covers the instances that existed today. This
  // walks the whole renderer so the NEXT one fails a test instead of reaching
  // the founder — species 46: assert the guarantee over the container, never
  // over the filenames you happen to know.
  const RENDERER = join(__dirname, '..', '..', '..')

  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...walk(full))
      else if (/\.tsx?$/.test(entry.name) && !/__tests__/.test(full)) out.push(full)
    }
    return out
  }

  it('no file keys a navigation destination off a record KIND', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      // The exact shape of both bugs: a table from a record's category to a
      // screen. It cannot express "which record", so it always loses the id.
      if (/Record<\s*RecentKind\s*,\s*NavId\s*>/.test(code)) {
        offenders.push(file.slice(file.indexOf('renderer')))
      }
    }
    expect(
      offenders,
      'these route a record by its category, so the item id is discarded — derive the destination from the item (see recentTarget)'
    ).toEqual([])
  })

  it('both recent surfaces hand over the whole item', () => {
    const sidebar = readFileSync(join(__dirname, '..', 'Sidebar.tsx'), 'utf8')
    const palette = readFileSync(join(__dirname, '..', 'CommandPalette.tsx'), 'utf8')
    expect(sidebar).toContain('onSelectRecent(item)')
    expect(palette).toContain('recentTarget(row.recent)')
  })
})

describe('a redirected navigation keeps the tab it asked for', () => {
  // The M31 half. OLD_TO_HUB answers "which screen"; without OLD_TO_HUB_TAB it
  // silently dropped "which part of it".
  it('every id absorbed by a hub says which tab it is', () => {
    const absorbed = Object.keys(OLD_TO_HUB) as (keyof typeof OLD_TO_HUB)[]
    const missing = absorbed.filter((id) => !OLD_TO_HUB_TAB[id])
    expect(
      missing,
      'these ids redirect into a hub without saying which tab — they will land on its default'
    ).toEqual([])
  })

  it('names a tab that the destination hub actually has', () => {
    // A tab string nobody renders would fail OPEN: the hub would ignore it and
    // show its default, i.e. exactly the bug, but now with a config line that
    // makes it look handled. Read the real TABS arrays.
    const hubFile: Record<string, string> = {
      calls: 'CallsHub',
      pipeline: 'PipelineHub',
      coaching: 'CoachingHub',
      library: 'LibraryHub'
    }
    for (const [oldId, hub] of Object.entries(OLD_TO_HUB)) {
      const tab = OLD_TO_HUB_TAB[oldId as keyof typeof OLD_TO_HUB_TAB]
      if (!tab) continue
      const file = hubFile[hub as string]
      if (!file) continue
      const src = readFileSync(join(__dirname, '..', '..', '..', 'app', `${file}.tsx`), 'utf8')
      // CallsHub has no TABS array (two literal buttons), so match either the
      // declared tab union or a TABS entry.
      const declares =
        src.includes(`id: '${tab}'`) || new RegExp(`'${tab}'`).test(src.slice(0, 600))
      expect(declares, `${oldId} -> ${hub} names tab '${tab}', which ${file} does not have`).toBe(
        true
      )
    }
  })
})
