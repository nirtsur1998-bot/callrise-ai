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
      // Keep the AudioWorklet AND every bundled font as real emitted files
      // (never inlined data: URLs), so they load under our 'self'-only
      // Content-Security-Policy.
      //
      // The font half was found by building and reading the output, not by
      // reasoning: most woff2 subsets are comfortably over the 4KB default
      // inline limit and get emitted as files, but the small ones — Manrope's
      // cyrillic-ext is ~3KB — fell under it and were inlined as
      // `url(data:font/woff2;base64,...)`. That would have been blocked in
      // production and silently fallen back to a system face, because
      // renderer/index.html's meta CSP declares no `font-src` and therefore
      // inherits `default-src 'self'`, which does NOT permit data: — even
      // though the response header in main/index.ts does allow it. The
      // strictest of the two policies wins, so the header's permission is not
      // a rescue. Emitting files keeps both policies satisfied without
      // loosening either.
      assetsInlineLimit: (filePath: string) =>
        filePath.includes('pcm-processor') || /\.(woff2?|otf|ttf)$/i.test(filePath)
          ? false
          : undefined
    }
  }
})
