// M20: IPC surface for the Settings → Model Assignment picker to read the
// catalog (bundled data instantly, live-resolved availability on demand)
// and to assign a primary model per job.
import { ipcMain } from 'electron'
import { MODEL_CATALOG, catalogEntry, resolveCatalog } from './model-catalog'
import { DEFAULT_CATALOG_CHAIN } from './complete-with-fallback'
import { loadAppSettings, saveAppSettings } from '../app-settings'
import type { AIPurpose } from './types'

const ASSIGNABLE_PURPOSES: AIPurpose[] = [
  'coaching-cue',
  'summary',
  'scorecard',
  'tasks',
  'prep-brief',
  'deal-tier1',
  'deal-tier2'
]

export function registerModelCatalog(): void {
  // Bundled catalog only — instant, no network, used for the picker's first
  // paint before the live check (below) resolves.
  ipcMain.handle('aiCatalog:list', () => MODEL_CATALOG)

  // Cross-checked against each configured provider's live /models endpoint.
  // `forceRefresh` backs a manual "Refresh" action in Settings.
  ipcMain.handle('aiCatalog:resolve', async (_event, forceRefresh: unknown) => {
    return resolveCatalog({ forceRefresh: forceRefresh === true })
  })

  // V1 chain-editing scope (see docs/ai-providers.md's M20 addendum): the
  // user picks ONE primary model per job, and the chain is auto-derived as
  // [primary, ...DEFAULT_CATALOG_CHAIN[purpose] minus primary] - promoting
  // the pick to the front of the bundled default ordering. Computed here
  // (not in the renderer) so DEFAULT_CATALOG_CHAIN has exactly one home -
  // this file can import both app-settings.ts and complete-with-fallback.ts
  // without a cycle (neither of those imports this file).
  ipcMain.handle('settings:assignPrimaryModel', (_event, purpose: unknown, catalogId: unknown) => {
    if (
      typeof purpose !== 'string' ||
      !ASSIGNABLE_PURPOSES.includes(purpose as AIPurpose) ||
      typeof catalogId !== 'string' ||
      !catalogEntry(catalogId)
    ) {
      return loadAppSettings()
    }
    const p = purpose as AIPurpose
    const rest = DEFAULT_CATALOG_CHAIN[p].filter((id) => id !== catalogId)
    const chain = [catalogId, ...rest]
    return saveAppSettings({ aiModelAssignments: { [p]: { chain } } })
  })

  // The counterpart to assignPrimaryModel — clears a job back to an empty
  // chain, which resolveChain() (complete-with-fallback.ts) already treats as
  // "automatically pick the best available model": today's active provider if
  // one's configured, else the bundled DEFAULT_CATALOG_CHAIN, skipping
  // whatever the user has no key for. Exposed as its own explicit action
  // (not "assign catalogId: null") so a manual pick and a deliberate
  // "go back to automatic" read as two distinct, equally first-class choices
  // in the picker, not one hidden behind the other.
  ipcMain.handle('settings:resetToAutomatic', (_event, purpose: unknown) => {
    if (typeof purpose !== 'string' || !ASSIGNABLE_PURPOSES.includes(purpose as AIPurpose)) {
      return loadAppSettings()
    }
    const p = purpose as AIPurpose
    return saveAppSettings({ aiModelAssignments: { [p]: { chain: [] } } })
  })
}
