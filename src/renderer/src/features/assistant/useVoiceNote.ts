// M28 Phase 3 — composer voice notes. Records with plain getUserMedia +
// MediaRecorder (the mic-test precedent — deliberately NOTHING from the
// live-call capture path: no recorder.ts, no transcription session, no call
// detection, no consent flow; this is the user's own voice on their own
// explicit press). Transcription is one REST round-trip in main; the text
// lands in the composer FOR REVIEW — never auto-sent.
//
// Audit-fix rewrite (E-area): every way a recording ENDS — Done click, the
// 5-minute cap, the mic being unplugged, a recorder error — funnels through
// ONE finishRecording() path, so no ending can wedge the composer or drop
// the take. A failed transcription now genuinely KEEPS the audio (the blob
// is held for retry), making the error copy true instead of aspirational.
import { useCallback, useEffect, useRef, useState } from 'react'

export type VoiceNoteState = 'idle' | 'recording' | 'transcribing'

export interface PendingVoiceNote {
  mediaId: string
  durationMs: number
}

export interface UseVoiceNoteOptions {
  /** Receives the reviewed-ready transcript for the composer. Called on
   *  EVERY successful transcription, including cap/unplug auto-finishes. */
  onTranscript?: (text: string) => void
}

export interface UseVoiceNote {
  state: VoiceNoteState
  elapsedMs: number
  /** 0..1 rough input level for the recording indicator. */
  level: number
  error: string | null
  /** True when a failed take is being held for retry. */
  canRetry: boolean
  /** The transcribed-and-stored note waiting to ride the next send. */
  pending: PendingVoiceNote | null
  start: () => Promise<void>
  /** Stop and transcribe — the Done button. Cap/unplug call it internally. */
  finishRecording: () => Promise<void>
  /** Re-transcribe the kept failed take. */
  retryTranscribe: () => Promise<void>
  cancelRecording: () => void
  discardPending: () => void
  clearPending: () => void
  clearError: () => void
}

export const MAX_RECORDING_MS = 5 * 60 * 1000

export function useVoiceNote(options?: UseVoiceNoteOptions): UseVoiceNote {
  const [state, setState] = useState<VoiceNoteState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingVoiceNote | null>(null)
  const [canRetry, setCanRetry] = useState(false)

  const optionsRef = useRef(options)
  optionsRef.current = options
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const startingRef = useRef(false)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef(0)
  const stopResolveRef = useRef<((blob: Blob | null) => void) | null>(null)
  /** A failed take, kept so "your recording is kept" is TRUE. */
  const failedTakeRef = useRef<{ blob: Blob; durationMs: number } | null>(null)
  const finishRef = useRef<() => Promise<void>>(async () => {})

  const teardown = useCallback((): void => {
    if (tickRef.current) clearInterval(tickRef.current)
    tickRef.current = null
    cancelAnimationFrame(rafRef.current)
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    void audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    recorderRef.current = null
    setLevel(0)
  }, [])

  useEffect(() => teardown, [teardown])

  const transcribeBlob = useCallback(async (blob: Blob, durationMs: number): Promise<void> => {
    setState('transcribing')
    try {
      const result = await window.api.assistant.transcribeVoiceNote(
        await blob.arrayBuffer(),
        'audio/webm',
        durationMs
      )
      setState('idle')
      if (!result.ok) {
        failedTakeRef.current = { blob, durationMs }
        setCanRetry(true)
        setError(result.message)
        return
      }
      failedTakeRef.current = null
      setCanRetry(false)
      setPending({ mediaId: result.mediaId, durationMs: result.durationMs })
      optionsRef.current?.onTranscript?.(result.text)
    } catch {
      // IPC itself failed — same keep-and-retry contract, never a frozen
      // "Transcribing…" state.
      setState('idle')
      failedTakeRef.current = { blob, durationMs }
      setCanRetry(true)
      setError('Transcription failed unexpectedly. Your recording is kept — Retry or type instead.')
    }
  }, [])

  const finishRecording = useCallback(async (): Promise<void> => {
    const recorder = recorderRef.current
    if (!recorder) return
    const durationMs = Date.now() - startedAtRef.current
    const blobPromise = new Promise<Blob | null>((resolve) => {
      stopResolveRef.current = resolve
    })
    try {
      recorder.stop()
    } catch {
      stopResolveRef.current = null
      teardown()
      setState('idle')
      setError('Recording was interrupted.')
      return
    }
    teardown()
    const blob = await blobPromise
    if (!blob) {
      setState('idle')
      setError('Nothing was recorded.')
      return
    }
    await transcribeBlob(blob, durationMs)
  }, [teardown, transcribeBlob])
  finishRef.current = finishRecording

  const start = useCallback(async (): Promise<void> => {
    if (state !== 'idle' || startingRef.current) return
    startingRef.current = true
    setError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
    } catch {
      startingRef.current = false
      setError('Microphone access was denied — allow it in your system settings to record.')
      return
    }
    streamRef.current = stream
    chunksRef.current = []
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    recorderRef.current = recorder
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      stopResolveRef.current?.(blob.size > 0 ? blob : null)
      stopResolveRef.current = null
    }
    // Audit fixes: a recorder error or the mic disappearing (unplugged /
    // revoked) both finish the take with whatever was captured, through the
    // exact same path as the Done button — never a wedged composer.
    recorder.onerror = () => void finishRef.current()
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => void finishRef.current())
    }
    recorder.start(250)
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setState('recording')
    startingRef.current = false
    tickRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      // Audit fix: the cap finishes the take through the REAL flow —
      // transcribe + hand the text to the composer — instead of orphaning
      // the recorder mid-state.
      if (elapsed >= MAX_RECORDING_MS && recorderRef.current) {
        void finishRef.current()
      }
    }, 200)

    // Level meter (visual only) — a plain analyser on the same stream.
    try {
      const ctx = new AudioContext()
      audioCtxRef.current = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const loop = (): void => {
        analyser.getByteTimeDomainData(data)
        let sum = 0
        for (const v of data) sum += (v - 128) * (v - 128)
        setLevel(Math.min(1, Math.sqrt(sum / data.length) / 40))
        rafRef.current = requestAnimationFrame(loop)
      }
      rafRef.current = requestAnimationFrame(loop)
    } catch {
      // Meter is decorative — recording works without it.
    }
  }, [state])

  const retryTranscribe = useCallback(async (): Promise<void> => {
    const take = failedTakeRef.current
    if (!take || state !== 'idle') return
    setError(null)
    await transcribeBlob(take.blob, take.durationMs)
  }, [state, transcribeBlob])

  const cancelRecording = useCallback((): void => {
    if (state !== 'recording') return
    stopResolveRef.current = null
    try {
      recorderRef.current?.stop()
    } catch {
      // already stopped by an error path — teardown below is what matters
    }
    teardown()
    setState('idle')
    setElapsedMs(0)
  }, [state, teardown])

  const discardPending = useCallback((): void => {
    if (pending) void window.api.assistant.discardVoiceNote(pending.mediaId)
    setPending(null)
  }, [pending])

  return {
    state,
    elapsedMs,
    level,
    error,
    canRetry,
    pending,
    start,
    finishRecording,
    retryTranscribe,
    cancelRecording,
    discardPending,
    clearPending: useCallback(() => setPending(null), []),
    clearError: useCallback(() => {
      setError(null)
      setCanRetry(false)
      failedTakeRef.current = null
    }, [])
  }
}
