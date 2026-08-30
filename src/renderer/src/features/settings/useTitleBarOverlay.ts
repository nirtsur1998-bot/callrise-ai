import { useEffect } from 'react'

/**
 * M31 — keep the Windows caption buttons legible against the app's own chrome.
 *
 * With `titleBarStyle: 'hidden'` + `titleBarOverlay`, Windows draws the real
 * minimise/maximise/close buttons into a region at the top right of OUR
 * window. The OS has no idea what we are painting behind them, so the overlay
 * keeps whatever colour the window was created with. Flip to the light theme
 * and you get near-white symbols on near-white chrome: the close button
 * disappears. It has to be pushed on every change.
 *
 * TWO signals, not one — theme AND the design preview — which is why this
 * reads the RESOLVED colours out of the live stylesheet rather than mapping
 * from a theme name. `getComputedStyle` on the root element returns whatever
 * `--color-canvas` currently is after every class on `<html>` has had its say
 * (`.light`, `.first-light`), so this cannot drift from the palette the way a
 * second hardcoded copy of the hexes would. It is also why the deps array is
 * the two flags: their values do not appear in the call, they just tell React
 * when the CSS underneath has changed.
 *
 * Canvas, not surface: the overlay sits over the main content column
 * (AppShell's drag strip), which is `bg-canvas`. The sidebar is `bg-surface`
 * and is on the other side of the window.
 */
function readHex(varName: string): string | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  // Tokens are authored as #rrggbb; anything else (a fallback, an oklch()
  // rewrite) is not something to hand to the OS, and main validates it again.
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : null
}

export function useTitleBarOverlay(themeMode: string, designPreview: boolean): void {
  useEffect(() => {
    // Two frames, not one. The class changes and the effect run in the same
    // tick, but the recomputed custom properties are only guaranteed after
    // the next paint — reading immediately returns the OLD palette, which
    // would leave the buttons exactly one theme-change behind. Cheap to be
    // sure rather than clever.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const color = readHex('--color-canvas')
        const symbolColor = readHex('--color-ink')
        if (!color || !symbolColor) return
        void window.api.app.setTitleBarOverlay({ color, symbolColor }).catch(() => {
          /* not Windows, or an OS build without overlay support */
        })
      })
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [themeMode, designPreview])
}
