import './index.css'

import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* null, not a spinner: the overlay window is transparent by design, and
        a visible loading flash on a window with no backdrop looks like a
        rendering bug rather than a brief, real load. */}
    <Suspense fallback={null}>{isDetectionOverlay ? <DetectionOverlay /> : <App />}</Suspense>
  </StrictMode>
)
