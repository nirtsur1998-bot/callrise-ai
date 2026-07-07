import { useSyncExternalStore } from 'react'
import { loadThemeMode, saveThemeMode, type ThemeMode } from './theme'

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

/** Applies the resolved theme directly to <html> — a global DOM mutation, not
 *  React-rendered state. */
function applyResolvedTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
  document.documentElement.classList.toggle('light', resolved === 'light')
}

// ONE module-level store shared by every useTheme() instance. With per-hook
// state, App.tsx's instance never learned about a change made on the Settings
// page: launched in 'system' it kept its OS listener and reverted an explicit
// Dark choice on the next OS flip; launched in 'dark'/'light' the only OS
// listener belonged to the Settings page and died when it unmounted.
let currentMode: ThemeMode = loadThemeMode()
const listeners = new Set<() => void>()

function setThemeMode(next: ThemeMode): void {
  saveThemeMode(next)
  currentMode = next
  applyResolvedTheme(next)
  syncSystemListener()
  for (const l of listeners) l()
}

// The OS dark/light listener lives at module level too — it must survive the
// Settings page unmounting, and must only be active while mode === 'system'.
let mq: MediaQueryList | null = null
const onSystemChange = (): void => applyResolvedTheme('system')

function syncSystemListener(): void {
  if (currentMode === 'system' && !mq) {
    mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', onSystemChange)
  } else if (currentMode !== 'system' && mq) {
    mq.removeEventListener('change', onSystemChange)
    mq = null
  }
}

// Apply once at module load, before React mounts — also removes the dark
// flash light-theme users saw while waiting for the first effect to run.
applyResolvedTheme(currentMode)
syncSystemListener()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): ThemeMode {
  return currentMode
}

export interface UseTheme {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
}

/** Read/set the app-wide theme. All instances (App shell, Settings picker)
 *  share one store, so a change anywhere is seen everywhere. */
export function useTheme(): UseTheme {
  const mode = useSyncExternalStore(subscribe, getSnapshot)
  return { mode, setMode: setThemeMode }
}
