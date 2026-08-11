// M23 bug hunt: --diagnose's channel self-test used to call channel-test.ts's
// OWN reimplementation of the interleave logic, never the real
// pcm-processor.js that actually runs live — so a real bug in the live
// worklet (e.g. mic/buyer channels swapped) could pass the self-test
// cleanly. This proves loadRealWorkletRender() genuinely loads and executes
// the real, unmodified file — including that it would catch exactly that
// class of bug, not just that it "looks right".
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRealWorkletRender } from '../real-worklet-render'
import { runChannelSelfTest } from '../channel-test'

// The asset only exists after a build (`npm run build` / electron-vite build)
// — a fresh checkout with no prior build legitimately has nothing to find
// here, which is exactly the "not built" case loadRealWorkletRender()
// already handles by returning null. Skip rather than fail in that case.
const assetsDir = join(__dirname, '..', '..', '..', '..', 'out', 'renderer', 'assets')
const hasBuiltWorklet =
  existsSync(assetsDir) && readdirSync(assetsDir).some((f) => f.startsWith('pcm-processor'))

describe.skipIf(!hasBuiltWorklet)('loadRealWorkletRender — the real pcm-processor.js', () => {
  it('loads successfully from the built renderer output', () => {
    expect(loadRealWorkletRender()).not.toBeNull()
  })

  it('the real worklet passes the channel self-test — mic and buyer are not swapped', () => {
    const render = loadRealWorkletRender()
    expect(render).not.toBeNull()
    const stereo = runChannelSelfTest(16000, 2, render!)
    expect(stereo.pass).toBe(true)
    expect(stereo.detail).toBe('every channel carried its own tone')
  })

  it('mono mode: real worklet emits only channel 0, no phantom channel 1', () => {
    const render = loadRealWorkletRender()
    expect(render).not.toBeNull()
    const mono = runChannelSelfTest(16000, 1, render!)
    expect(mono.pass).toBe(true)
  })

  // The actual point of the fix, proven directly: if the render function
  // silently swapped mic and buyer, the self-test infrastructure catches it
  // — this uses a deliberately WRONG render (channels reversed) to prove
  // runChannelSelfTest would fail against a genuinely broken worklet, the
  // same detection mechanism now wired to the real code instead of a
  // reimplementation that could quietly agree with a bug.
  it('proves the self-test actually detects a swap — not just that the real worklet happens to pass', () => {
    const render = loadRealWorkletRender()
    expect(render).not.toBeNull()
    const swapped = (perChannel: Int16Array[]): ArrayBufferLike =>
      render!([...perChannel].reverse())
    const result = runChannelSelfTest(16000, 2, swapped)
    expect(result.pass).toBe(false)
    expect(result.detail).toMatch(/leaked into channel|carried no signal/)
  })
})

describe('loadRealWorkletRender — safety', () => {
  it('never throws, even if called with no built asset available', () => {
    // Can't easily force "not found" without touching the real filesystem
    // layout, but this documents and locks in the safety contract the rest
    // of diagnose.ts depends on: this function must be safe to call
    // unconditionally, in dev or packaged, with or without a build.
    expect(() => loadRealWorkletRender()).not.toThrow()
  })
})
