import { useSyncExternalStore } from 'react'
import { loadIdentityPreview, saveIdentityPreview } from './identityPreview'

// One module-level store, exactly like useTheme: the class on <html> is a
// global DOM mutation, and the App shell and the Settings toggle must not be
// able to disagree about it. (useTheme's own comment records what per-hook
// state cost last time.)
let enabled = loadIdentityPreview()
const listeners = new Set<() => void>()

function apply(on: boolean): void {
  document.documentElement.classList.toggle('first-light', on)
}

function setEnabled(next: boolean): void {
  saveIdentityPreview(next)
  enabled = next
  apply(next)
  for (const l of listeners) l()
}

// Applied at module load, before React mounts — same reason useTheme does it:
// otherwise the first paint is the old palette and the new one snaps in.
apply(enabled)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): boolean {
  return enabled
}

export interface UseIdentityPreview {
  enabled: boolean
  setEnabled: (on: boolean) => void
}

export function useIdentityPreview(): UseIdentityPreview {
  return { enabled: useSyncExternalStore(subscribe, getSnapshot), setEnabled }
}
