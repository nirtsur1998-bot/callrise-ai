// Controls for bug141-instrument.setup.ts. These prove the instrument can
// FIRE before any of its silences are read as evidence:
//   - a stall inside a module TRANSFORM must be named in resolving[]
//   - a stall inside a module EVALUATION leaves resolving[] empty (a real
//     limit of the field, documented so an empty set is never over-read)
//   - a stall on a plain timer leaves resolving[] empty and reqs {}
// Run: BUG141_SLOW_TRANSFORM=1 BUG141_LOG=<dir> node node_modules/vitest/vitest.mjs //        run --config vitest.bug141-controls.config.ts
// They live outside src/ on purpose: the reproduction loop must not collect them.
import { it, expect } from 'vitest'
it('POSITIVE control: stuck in TRANSFORM — resolving[] must name the module', async () => {
  const m = await import('./zz-slow-transform')
  expect(m.ready).toBe(true)
})
it('POSITIVE control: stuck EVALUATING a module — resolving[] is empty (documents the limit)', async () => {
  const m = await import('./slow-to-evaluate')
  expect(m.ready).toBe(true)
})
it('NEGATIVE control: stalled on a plain timer — resolving[] must be empty', async () => {
  await new Promise((r) => setTimeout(r, 4000))
  expect(true).toBe(true)
})
