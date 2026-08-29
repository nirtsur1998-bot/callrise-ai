import { useSyncExternalStore } from 'react'
import { loadNavigationPreview, saveNavigationPreview } from './navigationPreview'

// ONE module-level store shared by every useNavigationPreview() instance —
// same reasoning as useTheme.ts: a per-hook useState would let Settings'
// toggle and MainApp's own instance disagree about which is live.
let current = loadNavigationPreview()
const listeners = new Set<() => void>()

function setEnabled(next: boolean): void {
  saveNavigationPreview(next)
  current = next
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): boolean {
  return current
}

export interface UseNavigationPreview {
  enabled: boolean
  setEnabled: (next: boolean) => void
}

/** M31 Stage 2 — the 7-item sidebar + hub screens ship behind this flag,
 *  default OFF, so today's 12-item nav is completely unaffected until a user
 *  opts in from Settings -> Appearance. Flipping it off is a full, instant
 *  revert: no data changes, nothing to migrate, just a different nav-items
 *  list and a few extra MainApp switch cases that render unchanged existing
 *  screens inside a thin tab wrapper. */
export function useNavigationPreview(): UseNavigationPreview {
  const enabled = useSyncExternalStore(subscribe, getSnapshot)
  return { enabled, setEnabled }
}
