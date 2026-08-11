import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    // Mirrors tsconfig.web.json's path mapping — renderer code imports its own
    // siblings via `@renderer/...` (CLAUDE.md convention), and any test that
    // pulls in such a file (even transitively) needs the same resolution
    // vite/electron-vite already give it at build time.
    alias: {
      '@renderer': fileURLToPath(new URL('./src/renderer/src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
