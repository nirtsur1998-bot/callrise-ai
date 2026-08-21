// M28 Phase 3 — composer voice notes. Records with plain getUserMedia +
// MediaRecorder (the mic-test precedent — deliberately NOTHING from the
// live-call capture path: no recorder.ts, no transcription session, no call
// detection, no consent flow; this is the user's own voice on their own
// explicit press). Transcription is one REST round-trip in main; the text
// lands in the composer FOR REVIEW — never auto-sent.
import { useCallback, useEffect, useRef, useState } from 'react'

export type VoiceNoteState = 'idle' | 'recording' | 'transcribing'

export interface PendingVoiceNote {
  mediaId: string
  durationMs: number
}

export interface UseVoiceNote {
  state: VoiceNoteState
  elapsedMs: number
  /** 0..1 rough input level for the recording indicator. */
  level: number
  error: string | null
  /** The transcribed-and-stored note waiting to ride the next send. */
  pending: PendingVoiceNote | null
  start: () => Promise<void>
  /** Stop, transcribe, and resolve with the text for the composer ('' on failure). */
  stopAndTranscribe: () => Promise<string>
  cancelRecording: () => void
  discardPending: () => void
  clearPending: () => void
  clearError: () => void
}

export const MAX_RECORDING_MS = 5 * 60 * 1000

export function useVoiceNote(): UseVoiceNote {
  const [state, setState] = useState<VoiceNoteState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingVoiceNote | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef(0)
  const stopResolveRef = useRef<((blob: Blob | null) => void) | null>(null)

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

  const start = useCallback(async (): Promise<void> => {
    if (state !== 'idle') return
    setError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
    } catch {
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
    recorder.start(250)
    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setState('recording')
    tickRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      // Hard cap — a voice note is a message, not a meeting.
      if (elapsed >= MAX_RECORDING_MS) recorderRef.current?.stop()
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

  const stopAndTranscribe = useCallback(async (): Promise<string> => {
    const recorder = recorderRef.current
    if (!recorder || state !== 'recording') return ''
    const durationMs = Date.now() - startedAtRef.current
    const blobPromise = new Promise<Blob | null>((resolve) => {
      stopResolveRef.current = resolve
    })
    recorder.stop()
    teardown()
    setState('transcribing')
    const blob = await blobPromise
    if (!blob) {
      setState('idle')
      setError('Nothing was recorded.')
      return ''
    }
    const result = await window.api.assistant.transcribeVoiceNote(
      await blob.arrayBuffer(),
      'audio/webm',
      durationMs
    )
    setState('idle')
    if (!result.ok) {
      setError(result.message)
      return ''
    }
    setPending({ mediaId: result.mediaId, durationMs: result.durationMs })
    return result.text
  }, [state, teardown])

  const cancelRecording = useCallback((): void => {
    if (state !== 'recording') return
    stopResolveRef.current = null
    recorderRef.current?.stop()
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
    pending,
    start,
    stopAndTranscribe,
    cancelRecording,
    discardPending,
    clearPending: useCallback(() => setPending(null), []),
    clearError: useCallback(() => setError(null), [])
  }
}
