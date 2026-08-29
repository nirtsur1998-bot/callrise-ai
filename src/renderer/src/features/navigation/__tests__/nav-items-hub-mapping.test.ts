// M31 Stage 2 — the preview nav's revert path must never orphan a screen.
//
// Why this exists: toggling "Try the new navigation" off while sitting on a
// hub-only screen (Calls/Pipeline/Library) used to leave `active` pointing at
// an id the just-reverted 12-item sidebar has no entry for — nothing
// highlighted, content stuck on the hub. Caught by hand during Stage 2's own
// revert-path verification, not by any test, because HUB_TO_OLD's three
// entries were written by eye alongside NAV_ITEMS_PREVIEW rather than derived
// from it. This test derives the check from the data instead: any NEW hub id
// added to NAV_ITEMS_PREVIEW without a matching HUB_TO_OLD entry fails here,
// before it ships the same class of bug again.
import { describe, expect, it } from 'vitest'
import {
  NAV_ITEMS,
  NAV_ITEMS_PREVIEW,
  OLD_TO_HUB,
  HUB_TO_OLD,
  remapForPreview,
  type NavId
} from '../nav-items'

const legacyIds = new Set<NavId>(NAV_ITEMS.map((item) => item.id))
const previewIds = new Set<NavId>(NAV_ITEMS_PREVIEW.map((item) => item.id))
const hubOnlyIds = NAV_ITEMS_PREVIEW.map((item) => item.id).filter((id) => !legacyIds.has(id))

describe('nav-items hub mapping', () => {
  it('has at least one hub-only id to guard (sanity check the fixture itself)', () => {
    expect(hubOnlyIds.length).toBeGreaterThan(0)
  })

  it('gives every hub-only id a HUB_TO_OLD entry pointing at a real legacy id', () => {
    for (const id of hubOnlyIds) {
      const target = HUB_TO_OLD[id]
      expect(target, `HUB_TO_OLD['${id}'] is missing`).toBeDefined()
      expect(
        legacyIds.has(target as NavId),
        `HUB_TO_OLD['${id}'] = '${target}' is not in NAV_ITEMS`
      ).toBe(true)
    }
  })

  it('has every OLD_TO_HUB entry point at a real preview id', () => {
    for (const source of Object.keys(OLD_TO_HUB) as NavId[]) {
      const target = OLD_TO_HUB[source]
      expect(legacyIds.has(source), `OLD_TO_HUB source '${source}' is not in NAV_ITEMS`).toBe(true)
      expect(
        previewIds.has(target as NavId),
        `OLD_TO_HUB['${source}'] = '${target}' is not in NAV_ITEMS_PREVIEW`
      ).toBe(true)
    }
  })

  it('leaves ids valid in both nav sets (e.g. coaching) unchanged either way', () => {
    const sharedIds = [...legacyIds].filter((id) => previewIds.has(id))
    for (const id of sharedIds) {
      expect(remapForPreview(id, true)).toBe(OLD_TO_HUB[id] ?? id)
      expect(remapForPreview(id, false)).toBe(HUB_TO_OLD[id] ?? id)
    }
  })

  it('reverts every hub-only id to a legacy screen the reverted sidebar actually shows', () => {
    for (const id of hubOnlyIds) {
      const reverted = remapForPreview(id, false)
      expect(legacyIds.has(reverted)).toBe(true)
    }
  })

  it('regression: library reverts to knowledge (the exact Stage 2 repro)', () => {
    expect(remapForPreview('library', false)).toBe('knowledge')
    expect(remapForPreview('calls', false)).toBe('live-calls')
    expect(remapForPreview('pipeline', false)).toBe('crm')
  })
})
