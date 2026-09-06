// M27 Tier 1 — orchestration for "Test my microphone". Thin by design:
// every decision that could be wrong (what to capture, whether the engine
// may be stopped afterwards, whether the denoised take is playable) lives in
// mic-test.ts where it is unit-tested; this file is the Web Audio glue.
import { useCallback, useRef, useState } from 'react'
import { classifyMicError, MIC_OUTCOME_TEXT } from './micOutcome'
import { resolveTier1MicName } from '@renderer/features/live/audio/recorder'
import { getTier1Enabled, getDenoiseStrength, DENOISE_ATTEN_DB } from '@renderer/features/settings/prefs'
import {
  MIC_TEST_SECONDS,
  PcmAccumulator,
  planDenoisedHalf,
  denoisedTakeUsable
} from './mic-test'

// The engine's fixed output rate (CANONICAL_RATE in kern_bridge.cpp) — the
// rate the collected tier1:pcm frames are in, whatever any context runs at.
const ENGINE_RATE = 48000

export type MicTestPhase =
  | { id: 'idle' }
  | { id: 'recording'; secondsLeft: number }
  | { id: 'playing-raw' }
  | { id: 'playing-clean' }
  /** Done. `cleanPlayed: false` + reason = the denoised half could not run
   *  or produced nothing — shown to the user, since that absence is itself
   *  the diagnostic. */
  | { id: 'done'; cleanPlayed: boolean; reason?: string }
  | { id: 'error'; message: string }

export interface UseMicTest {
  phase: MicTestPhase
  /** Records ~5s from the mic (and, when eligible, the denoised pipe), then
   *  plays raw and cleaned takes back to back. Safe to call repeatedly. */
  runTest: () => void
}

export function useMicTest(): UseMicTest {
  const [phase, setPhase] = useState<MicTestPhase>({ id: 'idle' })
  const runningRef = useRef(false)

  const runTest = useCallback((): void => {
    if (runningRef.current) return
    runningRef.current = true
    void (async () => {
      let stream: MediaStream | null = null
      let unsubPcm: (() => void) | null = null
      let engineStartedByUs = false
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (err) {
          // BUG-190: the Audio page printed "Requested device not found" verbatim.
          const t = MIC_OUTCOME_TEXT[classifyMicError(err)]
          setPhase({ id: 'error', message: `${t.title}. ${t.body}` })
          return
        }
        const label = stream.getAudioTracks()[0]?.label ?? ''

        // Raw take: MediaRecorder is the simplest correct capture for a
        // listen-back (compression is irrelevant to "how do I sound").
        const recorder = new MediaRecorder(stream)
        const rawParts: Blob[] = []
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) rawParts.push(e.data)
        }

        // Denoised take, per the tested plan.
        const denoised = new PcmAccumulator(ENGINE_RATE * MIC_TEST_SECONDS)
        const status = await window.api.tier1.getStatus().catch(() => null)
        const plan = planDenoisedHalf(status, resolveTier1MicName(label))
        let planReason: string | undefined = plan.run
          ? undefined
          : plan.reason === 'engine-unavailable'
            ? 'the noise-cancellation engine wasn’t found'
            : 'this microphone can’t be cleaned (it’s already a virtual/processed device)'
        if (plan.run && getTier1Enabled()) {
          unsubPcm = window.api.tier1.onPcm((frame) => denoised.push(new Float32Array(frame)))
          if (plan.startEngine) {
            engineStartedByUs = true
            const mic = resolveTier1MicName(label)
            await window.api.tier1.start(
              mic!,
              DENOISE_ATTEN_DB[getDenoiseStrength()] ?? undefined
            )
          }
        } else if (plan.run && !getTier1Enabled()) {
          planReason = 'noise cancellation is switched off'
        }

        recorder.start()
        for (let s = MIC_TEST_SECONDS; s > 0; s--) {
          setPhase({ id: 'recording', secondsLeft: s })
          await new Promise((r) => setTimeout(r, 1000))
        }
        recorder.stop()
        await new Promise<void>((resolve) => {
          recorder.onstop = () => resolve()
        })

        // Capture side torn down BEFORE playback so the user never hears
        // themselves live while the takes play.
        unsubPcm?.()
        unsubPcm = null
        if (engineStartedByUs) await window.api.tier1.stop()
        engineStartedByUs = false
        stream.getTracks().forEach((t) => t.stop())
        stream = null

        // Play raw.
        setPhase({ id: 'playing-raw' })
        const rawUrl = URL.createObjectURL(new Blob(rawParts, { type: recorder.mimeType }))
        try {
          const audio = new Audio(rawUrl)
          // A machine with no playback device (or an empty take) rejects here
          // with a media-element error; that is a playback fact, said plainly.
          await audio.play().catch(() => {
            throw new Error('The recording could not be played back on this computer — check that a speaker or headset is set as the output device.')
          })
          await new Promise<void>((resolve) => {
            audio.onended = () => resolve()
            audio.onerror = () => resolve()
          })
        } finally {
          URL.revokeObjectURL(rawUrl)
        }

        // Play cleaned — only when the take is honestly playable.
        if (denoisedTakeUsable(denoised, ENGINE_RATE)) {
          setPhase({ id: 'playing-clean' })
          const ctx = new AudioContext() // unconstrained: playback wants fidelity, not ASR rate
          try {
            const samples = denoised.merged()
            const buf = ctx.createBuffer(1, samples.length, ENGINE_RATE)
            buf.getChannelData(0).set(samples)
            const src = ctx.createBufferSource()
            src.buffer = buf
            src.connect(ctx.destination)
            src.start()
            await new Promise<void>((resolve) => {
              src.onended = () => resolve()
            })
          } finally {
            void ctx.close()
          }
          setPhase({ id: 'done', cleanPlayed: true })
        } else {
          setPhase({
            id: 'done',
            cleanPlayed: false,
            reason:
              planReason ??
              'the engine produced no cleaned audio — this is worth reporting via Export diagnostics'
          })
        }
      } catch (err) {
        setPhase({ id: 'error', message: err instanceof Error ? err.message : String(err) })
      } finally {
        unsubPcm?.()
        if (engineStartedByUs) void window.api.tier1.stop()
        stream?.getTracks().forEach((t) => t.stop())
        runningRef.current = false
      }
    })()
  }, [])

  return { phase, runTest }
}
