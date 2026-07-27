import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app/App'
import { DetectionOverlay } from './features/detection/DetectionOverlay'

// The ambient-detection overlay (banner/toast/switch-prompt) is a second
// BrowserWindow loading this SAME bundle with a different URL hash, rather
// than a whole separate Vite entry point (see main/detection-overlay.ts).
const isDetectionOverlay = window.location.hash.startsWith('#/detection-overlay')

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isDetectionOverlay ? <DetectionOverlay /> : <App />}</StrictMode>
)
