// Regression guard for the Windows "live transcription silently dies / no
// words" bug (fixed 2026-07-29).
//
// Root cause: the §1.4 fast path transfers a MessagePortMain-derived port INTO a
// Web Worker, and Electron severs that port from the main process on transfer —
// the worker drains the audio ring and posts every frame, but nothing arrives at
// main (verified: ring READ_INDEX advances while main submittedSec stays 0).
// Worse, the handshake still "succeeds" (the worker's `ready` uses the
// worker<->window channel, not the main port), so bringing the fast path up
// switches the worklet to ring mode and SILENCES the postMessage fallback — a
// total audio blackout, no transcription, and a "No microphone found" teardown
// at the 10s no-audio watchdog.
//
// The fix declares the fast path unavailable so the proven postMessage path
// (worklet -> onChunk -> transcription.sendAudio) carries the call. This test
// fails if that guard is removed or re-enabled without first proving the worker
// can actually deliver audio to the main process. It reads source rather than
// importing pump.ts because pump.ts imports `./audio-pump.worker?worker`, a Vite
// transform vitest does not resolve (see pcm-processor.test.ts for the same
// constraint).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pumpSource = readFileSync(
  fileURLToPath(new URL('../pump.ts', import.meta.url)),
  'utf8'
)

describe('audio pump fast path (Electron MessagePortMain-to-worker is broken)', () => {
  it('is gated off via fastPathEnabled() returning false', () => {
    // The gate exists...
    expect(pumpSource).toMatch(/function fastPathEnabled\s*\(\s*\)\s*:\s*boolean/)
    // ...and returns false. Collapse whitespace so formatting can't fool it.
    const flat = pumpSource.replace(/\s+/g, ' ')
    expect(flat).toMatch(/function fastPathEnabled\s*\(\s*\)\s*: boolean \{ return false \}/)
  })

  it('startAudioPump bails on the gate before ever constructing a Worker', () => {
    const gateIdx = pumpSource.indexOf('if (!fastPathEnabled()) return null')
    const workerIdx = pumpSource.indexOf('new PumpWorker()')
    expect(gateIdx).toBeGreaterThan(-1)
    // The early return must sit before the Worker is created, so the severed
    // port is never wired up.
    expect(workerIdx).toBeGreaterThan(gateIdx)
  })
})
