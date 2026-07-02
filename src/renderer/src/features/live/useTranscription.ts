import { useCallback, useEffect, useRef, useState } from 'react'
import { startRecorder, type Recorder } from './audio/recorder'
import type { LiveStatus } from './types'

// The lifecycle phase, driven by us + the main process. "paused" is tracked
// separately (see below) so a network blip can't silently un-pause the UI.
type LivePhase = Exclude<LiveStatus, 'paused'>

interface UseTranscription {
  status: LiveStatus
  finalText: string
  interimText: string
  latencyMs: number | null
  errorMessage: string | null
  analyser: AnalyserNode | null
  start: () => Promise<void>
  stop: () => Promise<void>
  togglePause: () => void
}

export function useTranscription(): UseTranscription {
  const [phase, setPhase] = useState<LivePhase>('idle')
  const [paused, setPaused] = useState(false)
  const [finalText, setFinalText] = useState('')
  const [interimText, setInterimText] = useState('')
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)

  const recorderRef = useRef<Recorder | null>(null)
  const latencySamples = useRef<number[]>([])
  const lastFinalRef = useRef('')

  // Subscribe to main-process events once.
  useEffect(() => {
    const offState = window.api.transcription.onState((payload) => {
      if (payload.state === 'listening') setPhase('listening')
      else if (payload.state === 'connecting') setPhase('connecting')
      else if (payload.state === 'reconnecting') setPhase('reconnecting')
      else if (payload.state === 'error') {
        setPhase('error')
        setPaused(false)
      }
      // 'idle' is driven by our own stop().
    })

    const offTranscript = window.api.transcription.onTranscript((payload) => {
      const text = payload.transcript.trim()
      if (payload.isFinal) {
        if (text) {
          setFinalText((prev) => (prev ? `${prev} ${text}` : text))
          lastFinalRef.current = text
        }
        // Always clear interim on a final — including an empty final (Deepgram
        // emits these during silence), which would otherwise freeze on screen.
        setInterimText('')
      } else if (!text) {
        setInterimText('')
      } else if (text !== lastFinalRef.current) {
        // Drop a late interim that merely repeats the words we just finalized.
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
      recorderRef.current?.stop()
      recorderRef.current = null
      setAnalyser(null)
    })

    return () => {
      offState()
      offTranscript()
      offError()
    }
  }, [])

  const start = useCallback(async () => {
    setErrorMessage(null)
    setFinalText('')
    setInterimText('')
    setLatencyMs(null)
    setPaused(false)
    latencySamples.current = []
    lastFinalRef.current = ''
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
          // Mic unplugged mid-session.
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
    setPhase('connecting')

    try {
      const result = await window.api.transcription.start({ sampleRate: recorder.sampleRate })
      if (!result.ok) {
        recorder.stop()
        recorderRef.current = null
        setAnalyser(null)
        setPhase(result.error === 'no-key' ? 'no-key' : 'error')
      }
      // On success, main emits 'listening' which flips the phase.
    } catch {
      recorder.stop()
      recorderRef.current = null
      setAnalyser(null)
      setErrorMessage('Could not start transcription. Please try again.')
      setPhase('error')
    }
  }, [])

  const stop = useCallback(async () => {
    recorderRef.current?.stop()
    recorderRef.current = null
    setAnalyser(null)
    setPaused(false)
    await window.api.transcription.stop()
    setInterimText('')
    setPhase('idle')
    // finalText is intentionally kept on screen after stopping.
  }, [])

  const togglePause = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder) return
    setPaused((prev) => {
      const next = !prev
      recorder.setPaused(next)
      return next
    })
  }, [])

  // Stop everything if the view unmounts.
  useEffect(() => {
    return () => {
      recorderRef.current?.stop()
      recorderRef.current = null
      void window.api.transcription.stop()
    }
  }, [])

  // "paused" only makes sense while a session is live; otherwise show the phase.
  const status: LiveStatus =
    paused && (phase === 'listening' || phase === 'reconnecting') ? 'paused' : phase

  return {
    status,
    finalText,
    interimText,
    latencyMs,
    errorMessage,
    analyser,
    start,
    stop,
    togglePause
  }
}
