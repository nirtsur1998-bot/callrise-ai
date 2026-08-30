import { useSyncExternalStore } from 'react'
import { loadDesignPreview, saveDesignPreview } from './designPreview'

/**
 * The one M31 redesign switch, as a single module-level store.
 *
 * Every surface that used to read its own flag now reads this one, which is
 * what makes "off" a single failure mode rather than four: there is no state
 * in which the nav is new and the palette is old. That was the founder's
 * condition for collapsing them — *"one switch means one failure mode: if
 * turning it off leaves any part of the new design behind, that's worse than
 * four switches."*
 *
 * Module-level rather than per-hook for the same reason as useTheme: the
 * Appearance toggle and the surfaces it controls are mounted at the same
 * time, and per-hook state would let them disagree about which design is
 * live while you are looking at both.
 *
 * The palette is applied here too, as a class on <html>, because it is the
 * one part of the redesign that is CSS rather than React — see index.css's
 * `:root:not(.first-light)` blocks, which hold the pre-M31 ramp verbatim.
 */
function apply(on: boolean): void {
  document.documentElement.classList.toggle('first-light', on)
}

let enabled = loadDesignPreview()
const listeners = new Set<() => void>()

function setEnabled(next: boolean): void {
  saveDesignPreview(next)
  enabled = next
  apply(next)
  for (const l of listeners) l()
}

// Applied at module load, before React mounts — otherwise the first paint is
// one palette and the other snaps in.
apply(enabled)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): boolean {
  return enabled
}

export interface UseDesignPreview {
  enabled: boolean
  setEnabled: (on: boolean) => void
}

export function useDesignPreview(): UseDesignPreview {
  return { enabled: useSyncExternalStore(subscribe, getSnapshot), setEnabled }
}
