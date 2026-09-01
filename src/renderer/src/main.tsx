// Bundled brand typefaces, imported BEFORE index.css so the @font-face rules
// are defined by the time the theme's --font-sans/--font-mono reference them.
//
// Self-hosted on purpose: our CSP is 'self'-only (see main/index.ts and
// renderer/index.html), so a Google Fonts <link> would be blocked outright —
// and a desktop app should not need the network to render its own text. Vite
// emits these as real asset files rather than data: URIs (they are far over
// assetsInlineLimit), which is what keeps them inside 'self'.
//
// Both are SIL OFL 1.1, which explicitly permits bundling and redistributing
// the font files as part of a software package. That is the clause that ruled
// Satoshi out — see docs/M31-typeface-license.md. The LICENSE files ship
// inside each package, so the notice travels with the font as OFL requires.
//
// Full family (all subsets), not latin-only: Summary language can render
// AI output in Cyrillic/Greek/Vietnamese, and falling back to a system face
// mid-sentence is exactly the kind of seam this stage exists to remove. The
// whole cost is ~270KB of woff2.
import '@fontsource-variable/manrope'
import '@fontsource-variable/geist-mono'

import './index.css'

import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

// Forward otherwise-invisible renderer crashes into the same persistent log
// file the main process writes to, so a report from the field has one file
// to attach instead of "it just went blank, no idea why."
window.addEventListener('error', (event) => {
  void window.api.app.logRendererError('window.onerror', event.error?.stack ?? event.message)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  void window.api.app.logRendererError('unhandledrejection', detail)
})

// The ambient-detection overlay (banner/toast/switch-prompt) is a second
// BrowserWindow loading this SAME bundle with a different URL hash, rather
// than a whole separate Vite entry point (see main/detection-overlay.ts).
//
// Both halves are lazy — this file is the ONE entry point Vite sees, so a
// static `import App from './app/App'` here would bundle the entire main app
// (every screen it can navigate to) into whichever window loads first,
// including the detection-overlay window, which only ever renders a small
// floating card and never touches App at all. Splitting here is what lets
// that window skip fetching/parsing App's code entirely, on top of whatever
// MainApp.tsx splits per-screen for the main window itself.
const App = lazy(() => import('./app/App'))
const DetectionOverlay = lazy(() =>
  import('./features/detection/DetectionOverlay').then((m) => ({ default: m.DetectionOverlay }))
)

const isDetectionOverlay = window.location.hash.startsWith('#/detection-overlay')

// The overlay window is `transparent: true` and loads THIS SAME index.html and
// index.css, whose `body { background-color: var(--color-canvas) }` is opaque.
// On a frameless transparent window that paints a solid rectangle filling the
// entire window, behind DetectionOverlay's rounded glass card and across the
// CARD_INSET padding that exists to give the card's shadow room -- which is
// exactly the "black box around the call-detection box" the founder has
// reported repeatedly.
//
// Worth being precise about why an earlier fix did not help: detection-overlay.ts
// already removed Windows' `backgroundMaterial: 'acrylic'` for the same visible
// symptom, and that WAS a real cause of a square backdrop -- at the OS
// compositor level. This is a second, independent cause of the same symptom, in
// our own stylesheet, which is why removing the first one left the box on screen.
//
// Set on the ROOT element rather than body so the CSS rule can key off it, and
// set here rather than in a component effect so it lands before first paint.
if (isDetectionOverlay) document.documentElement.dataset.window = 'overlay'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* null, not a spinner: the overlay window is transparent by design, and
        a visible loading flash on a window with no backdrop looks like a
        rendering bug rather than a brief, real load. */}
    <Suspense fallback={null}>{isDetectionOverlay ? <DetectionOverlay /> : <App />}</Suspense>
  </StrictMode>
)
