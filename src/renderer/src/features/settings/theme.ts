// Pure UI preference — renderer-only localStorage, same pattern as the
// consent script/jurisdiction and live-cue settings. The main process never
// needs to know the theme.

export type ThemeMode = 'dark' | 'light' | 'system'

const KEY = 'salesos.theme'

export function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'system' ? v : 'dark' // default: today's look, unchanged
  } catch {
    return 'dark'
  }
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* best-effort: a theme preference is non-critical */
  }
}
