// Runs ONLY the BUG-141 instrument controls (see bug141-controls/).
//
// NOTE: this does NOT use mergeConfig. mergeConfig CONCATENATES `include`
// rather than replacing it, so a "controls only" config built that way quietly
// runs the entire suite as well — which is exactly what happened the first
// time, on 2026-09-09, alongside a reproduction loop it then perturbed.
import { defineConfig } from 'vitest/config'

const slowTransform = {
  name: 'bug141-slow-transform',
  async transform(_code: string, id: string): Promise<null> {
    if (id.includes('zz-slow-transform')) await new Promise((r) => setTimeout(r, 5000))
    return null
  }
}

export default defineConfig({
  plugins: process.env.BUG141_SLOW_TRANSFORM ? [slowTransform] : [],
  test: {
    environment: 'node',
    include: ['scripts/verification/bug141-controls/*.test.ts'],
    testTimeout: 20_000,
    setupFiles: ['./scripts/verification/bug141-instrument.setup.ts']
  }
})
