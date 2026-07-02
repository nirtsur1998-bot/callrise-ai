import { useCallback, useEffect, useRef, useState } from 'react'
import { startRecorder, type Recorder } from './audio/recorder'
import { groupWords, mergeSegments } from './segments'
import type { LiveStatus } from './types'
import type { CallSegment } from '@renderer/features/calls/types'

type LivePhase = Exclude<LiveStatus, 'paused'>

interface UseTranscription {
  status: LiveStatus
  segments: CallSegment[]
  interimText: string
  latencyMs: number | null
  errorMessage: string | null
  analyser: AnalyserNode | null
  savedNotice: boolean
  start: () => Promise<void>
  stop: () => Promise<void>
  togglePause: () => void
}

export function useTranscription(): UseTranscription {
  const [phase, setPhase] = useState<LivePhase>('idle')
  const [paused, setPaused] = useState(false)
  const [segments, setSegments] = useState<CallSegment[]>([])
  const [interimText, setInterimText] = useState('')
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)

  const recorderRef = useRef<Recorder | null>(null)
  const latencySamples = useRef<number[]>([])
  // Synchronous mirror of `segments` so the save (on close) sees the latest.
  const segmentsRef = useRef<CallSegment[]>([])
  const startedAtRef = useRef<string>('')
  const startMsRef = useRef<number>(0)
  const durationMsRef = useRef<number>(0)
  const savePendingRef = useRef(false)

  // Arm a save (used by both Stop and mic-unplug, so they can't drift).
  const armSave = useCallback(() => {
    durationMsRef.current = startMsRef.current
      ? Math.round(performance.now() - startMsRef.current)
      : 0
    savePendingRef.current = segmentsRef.current.length > 0
  }, [])

  // Persist the call exactly once. Called when the session closes, but also on
  // a fast restart / unmount so a pending save is never lost to a new session.
  const flushPendingSave = useCallback(() => {
    if (!savePendingRef.current) return
    savePendingRef.current = false
    const captured = segmentsRef.current
    if (captured.length === 0) return
    void window.api.calls
      .save({
        startedAt: startedAtRef.current,
        durationMs: durationMsRef.current,
        segments: captured
      })
      .then(() => setSavedNotice(true))
      .catch(() => {
        /* non-fatal: the transcript is still on screen */
      })
  }, [])

  useEffect(() => {
    const offState = window.api.transcription.onState((payload) => {
      if (payload.state === 'listening') setPhase('listening')
      else if (payload.state === 'connecting') setPhase('connecting')
      else if (payload.state === 'reconnecting') setPhase('reconnecting')
      else if (payload.state === 'error') {
        setPhase('error')
        setPaused(false)
        savePendingRef.current = false
      }
    })

    const offTranscript = window.api.transcription.onTranscript((payload) => {
      const text = payload.transcript.trim()
      if (payload.isFinal) {
        let runs: CallSegment[] = []
        if (payload.words.length > 0) {
          runs = groupWords(payload.words)
        } else if (text) {
          // Rare: a final with no per-word data. Attribute it to the current
          // speaker rather than defaulting to Speaker 1.
          const lastSpeaker = segmentsRef.current.at(-1)?.speaker ?? 0
          runs = [{ speaker: lastSpeaker, text }]
        }
        if (runs.length > 0) {
          const merged = mergeSegments(segmentsRef.current, runs)
          segmentsRef.current = merged
          setSegments(merged)
        }
        setInterimText('')
      } else {
        // Interim words carry speaker labels too, but we intentionally show the
        // in-progress text as one faint line; it re-flows into speaker turns on
        // finalization.
        setInterimText(text)
      }
      if (text) {
        const samples = latencySamples.current
        samples.push(payload.lagMs)
        if (samples.length > 20) samples.shift()
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length
        setLatencyMs(Math.round(avg))
      }
    })

    const offError = window.api.transcription.onError((payload) => {
      setErrorMessage(payload.message)
      setPhase('error')
      setPaused(false)
      savePendingRef.current = false
      recorderRef.current?.stop()
      recorderRef.current = null
      setAnalyser(null)
    })

    // The session fully closed after a stop — the final flushed words are in,
    // so save now.
    const offClosed = window.api.transcription.onClosed(() => {
      flushPendingSave()
    })

    return () => {
      offState()
      offTranscript()
      offError()
      offClosed()
    }
  }, [flushPendingSave])

  const start = useCallback(async () => {
    // If a previous call is still waiting to be saved, save it before we reset.
    flushPendingSave()

    setErrorMessage(null)
    setSegments([])
    setInterimText('')
    setLatencyMs(null)
    setPaused(false)
    setSavedNotice(false)
    segmentsRef.current = []
    latencySamples.current = []
    savePendingRef.current = false
    setPhase('requesting')

    const access = await window.api.transcription.ensureMicAccess()
    if (access.status !== 'granted') {
      setPhase('denied')
      return
    }

    let recorder: Recorder
    try {
      recorder = await startRecorder(
        (chunk) => window.api.transcription.sendAudio(chunk),
        () => {
          // Mic unplugged mid-session — save what we have, then end the session.
          armSave()
          recorderRef.current?.stop()
          recorderRef.current = null
          setAnalyser(null)
          void window.api.transcription.stop()
          setPhase('no-device')
        }
      )
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') setPhase('denied')
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') setPhase('no-device')
      else {
        setErrorMessage(
          name === 'NotReadableError'
            ? 'Your microphone is being used by another app. Close it and try again.'
            : 'Could not start the microphone. Please try again.'
        )
        setPhase('error')
      }
      return
    }

    recorderRef.current = recorder
    setAnalyser(recorder.analyser)
    startedAtRef.current = new Date().toISOString()
    startMsRef.current = performance.now()
    setPhase('connecting')

    try {
      const result = await window.api.transcription.start({ sampleRate: recorder.sampleRate })
      if (!result.ok) {
        recorder.stop()
        recorderRef.current = null
        setAnalyser(null)
        setPhase(result.error === 'no-key' ? 'no-key' : 'error')
      }
    } catch {
      recorder.stop()
      recorderRef.current = null
      setAnalyser(null)
      setErrorMessage('Could not start transcription. Please try again.')
      setPhase('error')
    }
  }, [armSave, flushPendingSave])

  const stop = useCallback(async () => {
    armSave()
    recorderRef.current?.stop()
    recorderRef.current = null
    setAnalyser(null)
    setPaused(false)
    await window.api.transcription.stop()
    setInterimText('')
    setPhase('idle')
    // segments stay on screen after stopping; save fires on 'closed'.
  }, [armSave])

  const togglePause = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder) return
    setPaused((prev) => {
      const next = !prev
      recorder.setPaused(next)
      return next
    })
  }, [])

  useEffect(() => {
    return () => {
      // Save a stopped-but-not-yet-flushed call before tearing down.
      flushPendingSave()
      recorderRef.current?.stop()
      recorderRef.current = null
      void window.api.transcription.stop()
    }
  }, [flushPendingSave])

  const status: LiveStatus =
    paused && (phase === 'listening' || phase === 'reconnecting') ? 'paused' : phase

  return {
    status,
    segments,
    interimText,
    latencyMs,
    errorMessage,
    analyser,
    savedNotice,
    start,
    stop,
    togglePause
  }
}
