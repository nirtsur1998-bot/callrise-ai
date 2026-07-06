import { useCallback, useEffect, useRef, useState } from 'react'
import { startRecorder, type Recorder } from './audio/recorder'
import { groupWords, mergeSegments } from './segments'
import type { LiveStatus } from './types'
import type { CallSegment, ConsentRecord } from '@renderer/features/calls/types'
import {
  getAutoSummarize,
  getAutoGenerateTitle,
  addSeenApp
} from '@renderer/features/settings/prefs'

type LivePhase = Exclude<LiveStatus, 'paused'>

export type OtherPartyError = 'denied' | 'no-audio' | 'interrupted' | null

interface UseTranscription {
  status: LiveStatus
  segments: CallSegment[]
  interimText: string
  latencyMs: number | null
  errorMessage: string | null
  analyser: AnalyserNode | null
  savedNotice: boolean
  /** Whether the other party's audio is actually being captured right now. */
  otherPartyLive: boolean
  /** Last buyer-capture problem, if any (drives a recovery banner). */
  otherPartyError: OtherPartyError
  start: () => Promise<void>
  stop: () => Promise<void>
  togglePause: () => void
  /** Begin capturing the other party (call from a user gesture — opens
   *  getDisplayMedia). Re-checks consent after the async permission prompt. */
  enableOtherParty: () => Promise<void>
  /** Stop capturing the other party. Idempotent. */
  disableOtherParty: () => Promise<void>
}

export function useTranscription(
  consentRef?: { current: ConsentRecord },
  onStartReset?: () => void,
  /** AI Note Taker's "auto-open meeting page" — fired with the saved call's
   *  id after every successful save. Kept in a ref so it's always current
   *  without forcing flushPendingSave to be recreated on every render. */
  onSaved?: (callId: string) => void
): UseTranscription {
  const onSavedRef = useRef(onSaved)
  useEffect(() => {
    onSavedRef.current = onSaved
  }, [onSaved])

  const [phase, setPhase] = useState<LivePhase>('idle')
  const [paused, setPaused] = useState(false)
  const [segments, setSegments] = useState<CallSegment[]>([])
  const [interimText, setInterimText] = useState('')
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null)
  const [savedNotice, setSavedNotice] = useState(false)
  const [otherPartyLive, setOtherPartyLive] = useState(false)
  const [otherPartyError, setOtherPartyError] = useState<OtherPartyError>(null)

  const recorderRef = useRef<Recorder | null>(null)
  // Id of the main-process session THIS call owns. Passed as expectedSessionId
  // on the mono<->multichannel restarts so a stale in-flight toggle from an
  // already-stopped call can never tear down a newer call's session.
  const sessionIdRef = useRef<number | null>(null)
  // Re-entrancy guard: a rapid double-click on Try again/Resume must not run
  // two arm-then-getDisplayMedia sequences concurrently.
  const enablingOtherPartyRef = useRef(false)
  // Same guard, mirrored for the disable path — defense in depth alongside
  // the natural isLoopbackAttached() idempotency check below.
  const disablingOtherPartyRef = useRef(false)
  const latencySamples = useRef<number[]>([])
  // Synchronous mirror of `segments` so the save (on close) sees the latest.
  const segmentsRef = useRef<CallSegment[]>([])
  const startedAtRef = useRef<string>('')
  const startMsRef = useRef<number>(0)
  const durationMsRef = useRef<number>(0)
  const savePendingRef = useRef(false)
  // Set at a mono<->multichannel swap so the next transcript starts a fresh
  // segment — speaker ids mean different things across the swap (diarize vs
  // channel), so merging across it would mislabel/collide turns.
  const speakerBoundaryRef = useRef(false)

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
        segments: captured,
        // Consent captured during the session; the main process re-sanitizes it
        // and enforces the "no consent = no capture" invariant on save.
        consent: consentRef?.current
      })
      .then((saved) => {
        setSavedNotice(true)
        // AI Note Taker: fire-and-forget the opted-in auto-behaviors. Each is
        // independent — one failing (or being off) never affects the others.
        if (getAutoSummarize()) void window.api.calls.summarizeCall(saved.id).catch(() => {})
        if (getAutoGenerateTitle()) void window.api.calls.generateTitle(saved.id).catch(() => {})
        onSavedRef.current?.(saved.id)
      })
      .catch(() => {
        /* non-fatal: the transcript is still on screen */
      })
  }, [consentRef])

  useEffect(() => {
    const offState = window.api.transcription.onState((payload) => {
      if (payload.state === 'listening') setPhase('listening')
      else if (payload.state === 'connecting') setPhase('connecting')
      else if (payload.state === 'reconnecting') setPhase('reconnecting')
      else if (payload.state === 'error') {
        setPhase('error')
        setPaused(false)
        setOtherPartyLive(false)
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
          if (speakerBoundaryRef.current) {
            // Hard boundary across a mono<->multichannel swap: append fresh
            // rather than merge into the previous regime's segments.
            speakerBoundaryRef.current = false
            segmentsRef.current = [...segmentsRef.current, ...runs]
          } else {
            segmentsRef.current = mergeSegments(segmentsRef.current, runs)
          }
          setSegments(segmentsRef.current)
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
      setOtherPartyLive(false)
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
    // Each new call starts with consent reset to off — it never carries over.
    onStartReset?.()

    // AI Note Taker's exclude-apps list learns from every session (not just
    // auto-started ones) — best-effort, never blocks starting.
    void window.api.app
      .getActiveApp()
      .then((name) => {
        if (name) addSeenApp(name)
      })
      .catch(() => {})

    setErrorMessage(null)
    setSegments([])
    setInterimText('')
    setLatencyMs(null)
    setPaused(false)
    setSavedNotice(false)
    setOtherPartyLive(false)
    setOtherPartyError(null)
    segmentsRef.current = []
    latencySamples.current = []
    savePendingRef.current = false
    sessionIdRef.current = null
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
          setOtherPartyLive(false)
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
      } else {
        sessionIdRef.current = typeof result.sessionId === 'number' ? result.sessionId : null
      }
    } catch {
      recorder.stop()
      recorderRef.current = null
      setAnalyser(null)
      setErrorMessage('Could not start transcription. Please try again.')
      setPhase('error')
    }
  }, [armSave, flushPendingSave, onStartReset])

  const stop = useCallback(async () => {
    armSave()
    recorderRef.current?.stop() // also detaches any loopback
    recorderRef.current = null
    setAnalyser(null)
    setPaused(false)
    setOtherPartyLive(false)
    setOtherPartyError(null)
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

  // --- Other-party (buyer) capture, gated on consent -------------------------

  // Stop capturing the other party and return the socket to mono. Idempotent:
  // a no-op when no loopback is attached, so the consent-off effect can fire
  // freely (including the double reset on save + start).
  const disableOtherParty = useCallback(async () => {
    // Re-entrancy guard, mirroring enableOtherParty: a rapid double-call must
    // not run two mono-switch sequences concurrently.
    if (disablingOtherPartyRef.current) return
    disablingOtherPartyRef.current = true
    try {
      const recorder = recorderRef.current
      if (!recorder || !recorder.isLoopbackAttached()) return
      setOtherPartyLive(false)
      setOtherPartyError(null)
      recorder.detachLoopback() // stop capturing the buyer immediately
      speakerBoundaryRef.current = true
      try {
        // Switch the socket back to mono FIRST, then flip the worklet layout — so
        // the worklet never emits mono into the still-open multichannel socket.
        // expectedSessionId makes this a no-op in main if it lands after a newer
        // call already replaced the session (never clobber the new call).
        const res = await window.api.transcription.start({
          sampleRate: recorder.sampleRate,
          multichannel: false,
          expectedSessionId: sessionIdRef.current ?? undefined
        })
        if (res.ok && typeof res.sessionId === 'number') sessionIdRef.current = res.sessionId
      } catch {
        /* socket failures surface via the state/error handlers */
      }
      // The call may have stopped (or restarted) during the await — this recorder
      // is then already torn down and mustn't be touched.
      if (recorderRef.current !== recorder) return
      recorder.setStereo(false)
    } finally {
      disablingOtherPartyRef.current = false
    }
  }, [])

  // Begin capturing the other party. MUST be called from a user gesture (it
  // opens getDisplayMedia). Consent is re-checked AFTER the async permission
  // prompt, so a revoke during the prompt can't slip capture through.
  const enableOtherParty = useCallback(async () => {
    // Re-entrancy guard: ignore a second click while a previous enable is
    // still mid-flight (two concurrent arm-then-getDisplayMedia runs race).
    if (enablingOtherPartyRef.current) return
    enablingOtherPartyRef.current = true
    try {
      const recorder = recorderRef.current
      if (!recorder) return // no active mic session to attach to
      // Never even arm capture unless consent is already recorded for this call.
      const before = consentRef?.current
      if (!before || before.status !== 'consented' || before.recordOtherParty !== true) return
      setOtherPartyError(null)

      let audio: MediaStream
      try {
        // Arm the main-process one-shot grant synchronously — no await before
        // getDisplayMedia, so it stays a user gesture.
        window.api.loopback.arm()
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        display.getVideoTracks().forEach((t) => t.stop()) // we only want the audio
        if (display.getAudioTracks().length === 0) {
          display.getTracks().forEach((t) => t.stop())
          setOtherPartyError('no-audio')
          return
        }
        audio = new MediaStream(display.getAudioTracks())
      } catch {
        window.api.loopback.disarm()
        setOtherPartyError('denied')
        return
      }

      // Consent may have been revoked, or the call stopped, during the prompt.
      const c = consentRef?.current
      const stillConsented = c?.status === 'consented' && c.recordOtherParty === true
      if (!stillConsented || recorderRef.current !== recorder) {
        window.api.loopback.disarm()
        audio.getTracks().forEach((t) => t.stop())
        return
      }

      // Wire the loopback into the audio graph (worklet stays mono — ch1 ignored
      // — so nothing is captured until the socket is multichannel and we flip).
      recorder.attachLoopback(audio, () => {
        // Loopback ended on its own (OS revoked screen recording / stopped sharing).
        void disableOtherParty()
        setOtherPartyError('interrupted')
      })

      // Switch the socket to multichannel FIRST, then flip the worklet to stereo —
      // so interleaved PCM never reaches the still-open mono socket.
      // expectedSessionId makes this a no-op in main if it lands after a newer
      // call already replaced the session (never clobber the new call).
      let ok = false
      try {
        const res = await window.api.transcription.start({
          sampleRate: recorder.sampleRate,
          multichannel: true,
          expectedSessionId: sessionIdRef.current ?? undefined
        })
        ok = res?.ok === true
        if (ok && typeof res.sessionId === 'number') sessionIdRef.current = res.sessionId
      } catch {
        ok = false
      }
      if (!ok || recorderRef.current !== recorder) {
        // Roll back cleanly so the worklet and socket never disagree.
        recorder.detachLoopback()
        setOtherPartyError('denied')
        return
      }
      speakerBoundaryRef.current = true
      recorder.setStereo(true)
      setOtherPartyLive(true)
    } finally {
      enablingOtherPartyRef.current = false
    }
  }, [consentRef, disableOtherParty])

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
    otherPartyLive,
    otherPartyError,
    start,
    stop,
    togglePause,
    enableOtherParty,
    disableOtherParty
  }
}
