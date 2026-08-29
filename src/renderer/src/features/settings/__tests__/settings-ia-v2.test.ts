import { describe, it, expect } from 'vitest'
import {
  buildSettingsGroups,
  resolvePageId,
  LEGACY_PAGE_REDIRECTS,
  type SettingsGroup,
  type SettingsPageId
} from '../settings-nav'

/**
 * M31 Stage 5 — the reworked Settings IA.
 *
 * The promise made to the founder was specific: "Nothing removed. Four merges,
 * and every merged page keeps a visible heading inside its new home so 'where
 * did it go' always has an answer." A promise like that is worth exactly as
 * much as the test that can break it, so these check the promise rather than
 * describing the change.
 */

const ids = (groups: SettingsGroup[]): SettingsPageId[] => groups.flatMap((g) => g.items.map((i) => i.id))

// Both IAs are built with alerts LIVE here, deliberately. The alerts page is
// hidden in the shipped app because its backend was never deployed (BUG-083),
// and comparing the two IAs with it hidden would let a genuine V2 omission
// hide behind that filter.
const legacy = buildSettingsGroups(true, false)
const v2 = buildSettingsGroups(true, true)

describe('Settings IA v2', () => {
  it('reaches every page the shipped IA reaches — directly or by redirect', () => {
    const v2Ids = new Set(ids(v2))
    const missing = ids(legacy).filter((id) => !v2Ids.has(id) && !LEGACY_PAGE_REDIRECTS[id])
    expect(
      missing,
      `these pages exist today and would become unreachable: ${missing.join(', ')}`
    ).toEqual([])
  })

  it('invents no page that does not already exist', () => {
    // The other direction. A regroup should re-file existing pages, never
    // introduce a nav entry pointing at content nobody wrote.
    const legacyIds = new Set(ids(legacy))
    const invented = ids(v2).filter((id) => !legacyIds.has(id))
    expect(invented, `not present in the shipped IA: ${invented.join(', ')}`).toEqual([])
  })

  it('points every redirect at a page that actually exists in v2', () => {
    const v2Ids = new Set(ids(v2))
    for (const [from, to] of Object.entries(LEGACY_PAGE_REDIRECTS)) {
      expect(v2Ids.has(to as SettingsPageId), `${from} redirects to ${to}, which v2 has no page for`).toBe(true)
      // A redirect whose source still exists is a redirect that never fires —
      // it would silently rot into a lie about where that page lives.
      expect(v2Ids.has(from as SettingsPageId), `${from} still exists in v2, so its redirect is dead`).toBe(false)
    }
  })

  it('resolves every historical id to something renderable, in both IAs', () => {
    for (const id of ids(legacy)) {
      expect(ids(v2), `${id} -> ${resolvePageId(id, v2)}`).toContain(resolvePageId(id, v2))
      expect(ids(legacy)).toContain(resolvePageId(id, legacy))
    }
  })

  it('actually reduces the nav, and no group dominates', () => {
    // The two numbers the change exists to move. Written as the goal, not as
    // today's output, so tightening further stays green and regressing fails.
    expect(v2.length, 'v2 should have meaningfully fewer groups than the 11 shipped').toBeLessThan(9)

    const biggest = Math.max(...v2.map((g) => g.items.length))
    const total = ids(v2).length
    expect(
      biggest / total,
      `largest group holds ${biggest} of ${total} pages — the shipped IA's 8-of-21 is what this fixes`
    ).toBeLessThan(0.32)
  })

  it('keeps the alerts flag honoured in BOTH IAs', () => {
    // Species 17: a nav entry that ignores its flag. The V2 array lists the
    // alerts group like any other, so the filter is the only thing keeping a
    // page with no deployed backend out of the sidebar.
    expect(ids(buildSettingsGroups(false, true))).not.toContain('alerts')
    expect(ids(buildSettingsGroups(false, false))).not.toContain('alerts')
    expect(ids(buildSettingsGroups(true, true))).toContain('alerts')
  })

  it('does not bury the delete-my-data surface inside another page', () => {
    // Deliberate non-merge, recorded as a test so a later tidy-up has to argue
    // with something. 'sales-brain-memories' is where a person deletes what
    // the AI learned about them; it keeps its own row.
    expect(ids(v2)).toContain('sales-brain-memories')
    expect(LEGACY_PAGE_REDIRECTS['sales-brain-memories']).toBeUndefined()
  })

  it('gives every page a label that is not the old subsystem name', () => {
    const RENAMED: Partial<Record<SettingsPageId, string>> = {
      'ai-models': 'Model Assignment',
      crm: 'Contacts & matching',
      'live-deal-intelligence': 'Live Deal Intelligence',
      telemetry: 'Diagnostics & telemetry',
      'sales-brain-memories': 'Sales Brain — Memories',
      personalization: 'Personalization',
      app: 'App'
    }
    for (const group of v2) {
      for (const item of group.items) {
        const oldLabel = RENAMED[item.id]
        if (!oldLabel) continue
        expect(item.label, `${item.id} was supposed to be renamed away from "${oldLabel}"`).not.toBe(
          oldLabel
        )
      }
    }
  })
})
