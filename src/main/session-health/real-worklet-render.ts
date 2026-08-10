// M23: the --diagnose channel self-test used to call channel-test.ts's own
// `interleave()` reimplementation instead of exercising the live
// AudioWorkletProcessor (pcm-processor.js) — a real bug in the live
// interleaver could pass the self-test cleanly, defeating the whole point
// of a check built specifically to catch mic/buyer channel swaps (see
// channel-test.ts's own doc comment).
//
// pcm-processor.js runs on the renderer's audio thread and is loaded via
// `audioWorklet.addModule()` as a bare emitted asset (see
// electron.vite.config.ts's assetsInlineLimit override) — it is not bundled
// through Vite's normal module graph, and the main process (where --diagnose
// runs) has no Web Audio APIs at all. So the real file's SOURCE TEXT is read
// off disk and run in a small vm sandbox that stubs only the two Web-Audio
// globals it references (`AudioWorkletProcessor`, `registerProcessor`) —
// the actual PCMProcessor class, unmodified, is what gets exercised. This
// runs the real code without needing pcm-processor.js to import anything
// (which the worklet-loading path doesn't support) or needing a browser.
//
// Best-effort and always safe: if the asset can't be found or fails to load
// (wrong build layout, syntax error), this returns null and the caller falls
// back to channel-test.ts's own interleave() — reported honestly as a
// fallback, per diagnose.ts's own "never claim a check ran when it did not"
// rule, rather than silently pretending the real worklet was tested.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const WORKLET_DIRS = [
  // Packaged app / a normal `npm run build` output: electron-vite bundles
  // the WHOLE main process into a single out/main/index.js, so __dirname at
  // runtime is out/main/ regardless of which source file this code started
  // in — exactly the same one-level-up pattern index.ts's own
  // `join(__dirname, '../renderer/index.html')` relies on.
  join(__dirname, '..', 'renderer', 'assets'),
  // Running as unbundled TS source (vitest) instead of the real bundle —
  // __dirname here is this file's own src/ location, not out/main/, so the
  // above candidate can't resolve; cwd-relative is what actually finds a
  // prior build's output in that case.
  join(process.cwd(), 'out', 'renderer', 'assets')
  // electron-vite's dev server (`npm run dev`) never emits a hashed asset
  // file at all — the worklet loads straight from source via Vite's dev
  // middleware — so --diagnose run under dev legitimately finds nothing
  // here. That's a real "not built" case, not a bug in this resolver.
]

function findWorkletSource(): string | null {
  for (const dir of WORKLET_DIRS) {
    if (!existsSync(dir)) continue
    try {
      const match = readdirSync(dir).find(
        (f) => f.startsWith('pcm-processor') && f.endsWith('.js')
      )
      if (match) return readFileSync(join(dir, match), 'utf8')
    } catch {
      continue
    }
  }
  return null
}

interface SandboxedPCMProcessor {
  port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (data: unknown) => void }
  stereo: boolean
  process(inputs: Float32Array[][]): boolean
}

/** Load the REAL pcm-processor.js, sandboxed, and return a `render` function
 *  matching channel-test.ts's `runChannelSelfTest` signature — or null if the
 *  real file couldn't be found/loaded. Never throws. */
export function loadRealWorkletRender(): ((perChannel: Int16Array[]) => ArrayBufferLike) | null {
  const source = findWorkletSource()
  if (!source) return null

  try {
    const posted: ArrayBuffer[] = []
    const sandbox: Record<string, unknown> = {
      registerProcessor: (_name: string, cls: new () => SandboxedPCMProcessor) => {
        sandbox.__PCMProcessor = cls
      },
      AudioWorkletProcessor: class {
        port = { onmessage: null, postMessage: (data: unknown) => posted.push(data as ArrayBuffer) }
      }
    }
    runInContext(source, createContext(sandbox), { timeout: 1000 })
    const PCMProcessor = sandbox.__PCMProcessor as (new () => SandboxedPCMProcessor) | undefined
    if (!PCMProcessor) return null

    return (perChannel: Int16Array[]): ArrayBufferLike => {
      posted.length = 0
      const worklet = new PCMProcessor()
      const stereo = perChannel.length >= 2
      // Mirrors recorder.ts's setStereo(): a {type:'mode'} message, not a
      // direct property set, so this exercises the same mode-switch path a
      // real call takes (including the buffer resize/reset it does).
      worklet.port.onmessage?.({ data: { type: 'mode', stereo } })

      const mic = int16ToFloat32(perChannel[0])
      const buyer = stereo ? int16ToFloat32(perChannel[1]) : null
      const RENDER_QUANTUM = 128
      for (let i = 0; i < mic.length; i += RENDER_QUANTUM) {
        const micChunk = mic.subarray(i, i + RENDER_QUANTUM)
        const inputs: Float32Array[][] = stereo
          ? [[micChunk, buyer!.subarray(i, i + RENDER_QUANTUM)]]
          : [[micChunk]]
        worklet.process(inputs)
      }
      // Concatenate every flushed chunk — the self-test's tone is longer
      // than one worklet buffer, so it flushes multiple times.
      const totalBytes = posted.reduce((sum, b) => sum + b.byteLength, 0)
      const combined = new Uint8Array(totalBytes)
      let offset = 0
      for (const buf of posted) {
        combined.set(new Uint8Array(buf), offset)
        offset += buf.byteLength
      }
      return combined.buffer
    }
  } catch {
    return null
  }
}

function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff
  }
  return out
}
