// BUG-141 investigation config: the real config plus one instrumentation
// setup file. It deliberately changes NOTHING else — same include, same
// environment, same testTimeout (20s, and it stays 20s: raising it would hide
// the thing being measured).
//
// BUG141_SLOW_TRANSFORM additionally installs a plugin that makes ONE file's
// vite transform take 5 s. That is the positive control for the instrument's
// `resolving[]` field: it proves the field can actually name a module the
// worker is stuck FETCHING/TRANSFORMING, as opposed to one that is merely slow
// to evaluate (an evaluation stall leaves the set empty — measured).
import { mergeConfig } from 'vitest/config'
import base from './vitest.config'

const slowTransform = {
  name: 'bug141-slow-transform',
  async transform(_code: string, id: string): Promise<null> {
    if (id.includes('zz-slow-transform')) await new Promise((r) => setTimeout(r, 5000))
    return null
  }
}

export default mergeConfig(base, {
  plugins: process.env.BUG141_SLOW_TRANSFORM ? [slowTransform] : [],
  test: {
    setupFiles: ['./scripts/verification/bug141-instrument.setup.ts']
  }
})
