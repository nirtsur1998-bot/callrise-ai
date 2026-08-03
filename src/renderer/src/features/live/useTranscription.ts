import { useCallback, useEffect, useRef, useState } from 'react'
import { startRecorder, type Recorder } from './audio/recorder'
import { groupWords, mergeSegments } from './segments'
import { supportsOtherPartyCapture } from '@renderer/lib/platform'
import type { LiveStatus } from './types'
import type { CallSegment, ConsentRecord, SpeakerRole } from '@renderer/features/calls/types'
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
  /** The main-process transcription session id for the call in progress, or
   *  null before a session exists / after a failed start. A function (not a
   *  plain value) so callers always read the freshest ref, regardless of
   *  whether a re-render has happened since the last change. */
  getSessionId: () => number | null
  stop: () => Promise<void>
  togglePause: () => void
  /** Begin capturing the other party (call from a user gesture — opens
   *  getDisplayMedia). Re-checks consent after the async permission prompt. */
  enableOtherParty: () => Promise<void>
  /** Stop capturing the other party. Idempotent. */
  disableOtherParty: () => Promise<void>
  /** Tell the transcript who the rep is, once the coaching engine has worked
   *  it out under diarization. Back-fills only still-unknown turns in that
   *  epoch; decided turns are never revised. */
  identifyRep: (epoch: number, speaker: number) => void
  /** Whether multichannel buyer capture ran at any point in this call. The
   *  consent-retention strip keys on it: speaker 1 only means "the buyer" when
   *  it is a CHANNEL. */
  buyerCaptureUsed: () => boolean
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
  // Largely superseded by the per-result speakerEpoch (which also covers
  // reconnects, where this ref was never set), kept as belt-and-braces.
  const speakerBoundaryRef = useRef(false)
  // Which speaker label is the REP, per label namespace. Multichannel fills
  // this in immediately (channel 0 is the rep by construction); under
  // diarization it stays empty until the coaching engine identifies them, and
  // turns recorded before that are honestly marked 'unknown' rather than
  // guessed. Keyed by epoch so a reconnect can't carry a stale answer over.
  const repByEpochRef = useRef<Map<number, number>>(new Map())
  // Latches true the first time multichannel buyer capture actually starts, and
  // stays true for the rest of the call even if the buyer is dropped again —
  // the transcript still contains channel-labelled turns from that window.
  // This is what tells the consent-retention strip whether "speaker 1" is a
  // real buyer CHANNEL or just a diarization label on a mic-only call.
  const buyerCaptureUsedRef = useRef(false)

  /** Decide who said a turn AT THE MOMENT IT IS RECORDED. Never consulted
   *  again afterwards — that late re-read is what let one `repSpeaker` change
   *  retroactively relabel an entire call. */
  const resolveRole = useCallback(
    (speaker: number, epoch: number, certain: boolean): SpeakerRole => {
      if (!certain) return 'unknown'
      const rep = repByEpochRef.current.get(epoch)
      if (rep === undefined) return 'unknown'
      return speaker === rep ? 'rep' : 'other'
    },
    []
  )

  /**
   * Called once the coaching engine identifies the rep under diarization.
   * Back-fills ONLY turns still marked 'unknown' in that same epoch — already
   * decided turns are immutable, and other epochs belong to other namespaces
   * (so a speaker joining mid-call can't retro-relabel earlier segments).
   */
  const identifyRep = useCallback((epoch: number, speaker: number) => {
    if (repByEpochRef.current.get(epoch) === speaker) return
    repByEpochRef.current.set(epoch, speaker)
    let changed = false
    const next = segmentsRef.current.map((s) => {
      if (s.epoch !== epoch || s.role !== 'unknown') return s
      changed = true
      return { ...s, role: s.speaker === speaker ? ('rep' as const) : ('other' as const) }
    })
    if (changed) {
      segmentsRef.current = next
      setSegments(next)
    }
  }, [])

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
        consent: consentRef?.current,
        // Lets the retention strip tell a buyer CHANNEL from a diarization
        // label — without it, mic-only calls had speaker-1 turns deleted.
        buyerCaptureUsed: buyerCaptureUsedRef.current
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
        const epoch = payload.speakerEpoch
        // Multichannel: the label IS the channel, so the rep is channel 0 by
        // construction. Record it for this namespace before resolving roles.
        if (payload.multichannel && !repByEpochRef.current.has(epoch)) {
          repByEpochRef.current.set(epoch, 0)
        }
        const meta = {
          epoch,
          role: (speaker: number): SpeakerRole =>
            resolveRole(speaker, epoch, payload.speakerCertain),
          ...(payload.minConfidence !== null ? { confidence: payload.minConfidence } : {})
        }
        let runs: CallSegment[] = []
        if (payload.words.length > 0) {
          runs = groupWords(payload.words, meta)
        } else if (text) {
          // Rare: a final with no per-word data. Attribute it to the current
          // speaker rather than defaulting to Speaker 1 — but only within the
          // same epoch; across one, the previous label means someone else.
          const last = segmentsRef.current.at(-1)
          const lastSpeaker = last?.epoch === epoch ? last.speaker : 0
          const sameEpoch = last?.epoch === epoch
          runs = [
            {
              speaker: lastSpeaker,
              text,
              epoch,
              // Carrying over a speaker across an epoch boundary is a guess, so
              // it is recorded as one rather than asserted.
              role: sameEpoch ? resolveRole(lastSpeaker, epoch, payload.speakerCertain) : 'unknown',
              ...(payload.minConfidence !== null ? { confidence: payload.minConfidence } : {})
            }
          ]
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
    // Per-CALL state, and this hook instance outlives a single call (LiveView
    // stays mounted between them). Leaving it latched made the next mic-only
    // call report buyerCaptureUsed:true, which re-armed the retention strip and
    // permanently deleted its speaker-1 turns on save — the exact data loss
    // this flag exists to prevent.
    buyerCaptureUsedRef.current = false
    repByEpochRef.current = new Map()
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

  const getSessionId = useCallback(() => sessionIdRef.current, [])

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
    // Buyer capture rides on system-audio loopback, supported on macOS and
    // Windows. The main process refuses to arm on other platforms too — this
    // just avoids ever opening a doomed getDisplayMedia prompt there.
    if (!supportsOtherPartyCapture) return
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
      buyerCaptureUsedRef.current = true
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
    identifyRep,
    buyerCaptureUsed: () => buyerCaptureUsedRef.current,
    otherPartyLive,
    otherPartyError,
    start,
    getSessionId,
    stop,
    togglePause,
    enableOtherParty,
    disableOtherParty
  }
}
