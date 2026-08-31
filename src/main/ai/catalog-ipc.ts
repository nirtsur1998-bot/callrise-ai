// M20: IPC surface for the Settings → Model Assignment picker to read the
// catalog (bundled data instantly, live-resolved availability on demand)
// and to assign a primary model per job.
import { ipcMain } from 'electron'
import { MODEL_CATALOG, catalogEntry, resolveCatalog } from './model-catalog'
import { CANDIDATE_POOL } from './complete-with-fallback'
import { providerHasCredentials } from './provider-credentials'
import { loadAppSettings, saveAppSettings } from '../app-settings'
import type { AIPurpose } from './types'

// BUG-079: must list every purpose the Settings picker (JOBS in
// ModelAssignmentSection.tsx) actually renders a card for. This list was
// left behind twice already when new jobs (coaching-chat, memory-extract)
// were added to the UI but not here — both IPC handlers below silently
// no-op for an unlisted purpose, so the picker snapped back to "Automatic"
// with no error. 'other', 'memory-consolidate', and 'memory-reflect' are
// deliberately excluded — those AIPurpose values have no card in JOBS.
const ASSIGNABLE_PURPOSES: AIPurpose[] = [
  'coaching-cue',
  'summary',
  'scorecard',
  'tasks',
  'prep-brief',
  'deal-tier1',
  'deal-tier2',
  'coaching-chat',
  'memory-extract',
  // M28 — the Rise assistant chat. NOTE: BUG-079 (fixed in its own hotfix off
  // main) is this exact list drifting behind the Settings UI's job cards —
  // every purpose with a card in ModelAssignmentSection.tsx must be here.
  'assistant-chat'
]

/**
 * BUG-149 — derive the chain stored behind a user's primary pick.
 *
 * WHAT WAS WRONG. This used to be `[pick, ...DEFAULT_CATALOG_CHAIN[purpose]]`,
 * and for the two live purposes that list is ALREADY truncated by an ATTEMPTS
 * cap — `SPEED_CHAIN.slice(0, CHAIN_BUDGET.maxChainLength)` — whose two
 * survivors are both Groq. So whatever you picked for coaching-cue, the
 * fallback derived behind it came from a Groq-only list: a user holding Groq
 * AND Cerebras keys still got a single-provider chain, on the one path whose
 * entire budget is a single attempt. Taxonomy species 58's headline: a cap on
 * how many attempts we make is not a cap on which models are eligible.
 *
 * WHY SIMPLY READING THE UNCAPPED LANE IS NOT ENOUGH, checked rather than
 * assumed. `sanitizeModelAssignments` applies that same cap on every LOAD
 * (app-settings.ts), so a longer stored chain is truncated straight back to two
 * on the way out. Reading the uncapped pool but leaving the order alone gives
 * `[groq-8b, groq-70b]` again — the first two entries of SPEED_CHAIN are both
 * Groq. The pool has to be REORDERED so the two that survive the cap are the
 * two worth having.
 *
 * SO: different provider first, then same provider, then anything unkeyed.
 * That is the ordering `resolveConfiguredChain` already applies to its own
 * legacy tail ("Different providers FIRST, then at most ONE same-provider
 * model"), reused rather than re-invented.
 *
 * KEY-AWARE, AND THAT IS A REAL LIMITATION worth stating rather than hiding:
 * this reads `providerHasCredentials` at ASSIGN time, so a user who adds a
 * second provider's key LATER does not gain the cross-provider fallback until
 * they reassign the job. Unkeyed entries are kept at the tail rather than
 * dropped, so nothing is lost — they simply sort last, and the runtime skips
 * them anyway. The alternative (recomputing at read time) would silently
 * rewrite a setting the user chose, which is exactly what BUG-148 was about.
 */
function deriveChain(purpose: AIPurpose, pick: string): string[] {
const pickProvider = catalogEntry(pick)?.providerId
const entries = CANDIDATE_POOL[purpose]
  .filter((id) => id !== pick)
  .map((id) => catalogEntry(id))
  .filter((e): e is NonNullable<typeof e> => Boolean(e) && !e!.knownStale)

const keyed = entries.filter((e) => providerHasCredentials(e.providerId))
const unkeyed = entries.filter((e) => !providerHasCredentials(e.providerId))
const ordered = [
  ...keyed.filter((e) => e.providerId !== pickProvider),
  ...keyed.filter((e) => e.providerId === pickProvider),
  ...unkeyed
]
return [pick, ...ordered.map((e) => e.id)]
}

/**
 * BUG-149 follow-up — "tell me, don't fix it behind my back" (founder,
 * 2026-08-31).
 *
 * BUG-149's fix is deliberately FUTURE-ONLY: stored chains are not migrated,
 * and `deriveChain` reads credentials at ASSIGN time. Both were chosen so the
 * app never silently rewrites a setting the user made. But "we will not touch
 * it" and "we will not mention it" are different promises, and only the first
 * was intended — leaving the second is just a silent gap where someone keeps a
 * worse chain forever without ever being told a better one is available.
 *
 * So this reports, and changes nothing. Same shape as the demotion notice:
 * visible, explains itself, acts only when the user says so.
 *
 * DELIBERATELY NARROW. It fires ONLY when a stored chain is single-provider AND
 * re-deriving it now would cross providers. It does not fire for a cosmetic
 * reordering, or for a chain that is already cross-provider, or for a purpose
 * left on Automatic (nothing was assigned, so there is nothing to improve and
 * the runtime already derives fresh every call). A nudge that fires when
 * nothing meaningful changed is one people learn to dismiss.
 */
export function chainCouldCrossProviders(purpose: AIPurpose, chain: string[]): boolean {
if (chain.length === 0) return false
const providersOf = (ids: string[]): Set<string> =>
  new Set(
    ids
      .map((id) => catalogEntry(id)?.providerId)
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
  )

// Already spread across providers — nothing to say.
if (providersOf(chain).size > 1) return false

// Compare only the prefix that SURVIVES the cap, because that prefix is the
// whole of what ever runs. `chain` is already capped (sanitizeModelAssignments
// caps on every load), so its length is the live budget.
const derived = deriveChain(purpose, chain[0]).slice(0, chain.length)
return providersOf(derived).size > 1
}

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
    return saveAppSettings({ aiModelAssignments: { [p]: { chain: deriveChain(p, catalogId) } } })
  })

  // BUG-149 follow-up — which assigned jobs would gain a second provider if
  // they were reassigned right now. Read-only; the UI offers a button that
  // calls assignPrimaryModel with the SAME primary, so the user's actual pick
  // is never changed by taking the suggestion.
  ipcMain.handle('aiCatalog:chainsCouldImprove', () => {
    const assignments = loadAppSettings().aiModelAssignments
    return ASSIGNABLE_PURPOSES.filter((p) =>
      chainCouldCrossProviders(p, assignments[p]?.chain ?? [])
    )
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
