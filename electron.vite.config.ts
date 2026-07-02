import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // Keep node dependencies (ws, dotenv, …) external instead of bundling them.
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      // Keep the AudioWorklet as a real emitted file (never an inlined data:
      // URL), so it loads under our 'self'-only Content-Security-Policy.
      assetsInlineLimit: (filePath: string) =>
        filePath.includes('pcm-processor') ? false : undefined
    }
  }
})
