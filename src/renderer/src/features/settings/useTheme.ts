import { useCallback, useEffect, useState } from 'react'
import { loadThemeMode, saveThemeMode, type ThemeMode } from './theme'

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

/** Applies the resolved theme directly to <html> — a global DOM mutation, not
 *  React-rendered state, so every mounted useTheme() instance (App shell +
 *  the Settings page) stays visually correct without needing to sync state. */
function applyResolvedTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : mode
  document.documentElement.classList.toggle('light', resolved === 'light')
}

export interface UseTheme {
  mode: ThemeMode
  setMode: (mode: ThemeMode) => void
}

/** Reads the saved theme preference, applies it to <html>, and — for
 *  'system' — follows OS dark/light changes live. Mount this once high in
 *  the tree (App.tsx) for the global effect; Settings' Appearance page
 *  mounts its own instance just to drive the picker UI. */
export function useTheme(): UseTheme {
  const [mode, setModeState] = useState<ThemeMode>(() => loadThemeMode())

  useEffect(() => {
    applyResolvedTheme(mode)
  }, [mode])

  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => applyResolvedTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  const setMode = useCallback((next: ThemeMode) => {
    saveThemeMode(next)
    setModeState(next)
  }, [])

  return { mode, setMode }
}
