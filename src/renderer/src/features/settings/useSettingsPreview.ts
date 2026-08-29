import { useSyncExternalStore } from 'react'
import { loadSettingsPreview, saveSettingsPreview } from './settingsPreview'

// One module-level store shared by every instance, same as useTheme and
// useIdentityPreview: the Appearance toggle and the SettingsShell rendering
// the nav are mounted at the same time, and per-hook state would let them
// disagree about which IA is active while you are looking at both.
let enabled = loadSettingsPreview()
const listeners = new Set<() => void>()

function setEnabled(next: boolean): void {
  saveSettingsPreview(next)
  enabled = next
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): boolean {
  return enabled
}

export interface UseSettingsPreview {
  enabled: boolean
  setEnabled: (on: boolean) => void
}

export function useSettingsPreview(): UseSettingsPreview {
  return { enabled: useSyncExternalStore(subscribe, getSnapshot), setEnabled }
}
