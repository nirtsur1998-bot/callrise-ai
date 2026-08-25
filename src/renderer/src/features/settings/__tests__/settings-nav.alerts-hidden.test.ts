// BUG-083 — the Scheduled Alerts backend was never deployed, so the Settings
// page it feeds has failed for every user since M19. Until the backend is
// verified live, the nav entry is hidden behind ALERTS_BACKEND_LIVE.
//
// Both branches are asserted so the flag is proven to be WIRED (a switch
// whose off-position is never tested is taxonomy species 17: the setting
// whose write path doesn't actually connect). Red-checked by inverting the
// filter in buildSettingsGroups and watching the discriminating assertions
// fail in opposite directions.
import { describe, expect, it } from 'vitest'
import {
  ALERTS_BACKEND_LIVE,
  ALL_SETTINGS_PAGES,
  SETTINGS_GROUPS,
  buildSettingsGroups
} from '../settings-nav'

describe('BUG-083 — Alerts stays hidden until its backend is real', () => {
  it('the shipped flag is off', () => {
    expect(ALERTS_BACKEND_LIVE).toBe(false)
  })

  it('with the flag off, no group and no page mentions alerts', () => {
    const groups = buildSettingsGroups(false)
    expect(groups.some((g) => g.label === 'Alerts')).toBe(false)
    expect(groups.flatMap((g) => g.items).some((i) => i.id === 'alerts')).toBe(false)
  })

  it('with the flag on, the page comes back exactly as it was — the hide is a switch, not a deletion', () => {
    const groups = buildSettingsGroups(true)
    const alertsGroup = groups.find((g) => g.label === 'Alerts')
    expect(alertsGroup).toBeDefined()
    expect(alertsGroup?.items.map((i) => i.id)).toEqual(['alerts'])
    expect(alertsGroup?.items[0].label).toBe('Scheduled alerts')
    // and the only difference between the two builds is that one group
    expect(groups.length - buildSettingsGroups(false).length).toBe(1)
  })

  it('the live exports reflect the flag', () => {
    expect(SETTINGS_GROUPS.some((g) => g.label === 'Alerts')).toBe(ALERTS_BACKEND_LIVE)
    expect(ALL_SETTINGS_PAGES.some((p) => p.id === 'alerts')).toBe(ALERTS_BACKEND_LIVE)
  })
})
