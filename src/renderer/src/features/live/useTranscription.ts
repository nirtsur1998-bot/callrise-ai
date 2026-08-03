import { useCallback, useEffect, useRef, useState } from 'react'
import { startRecorder, type Recorder } from './audio/recorder'
import { groupWords, mergeSegments } from './segments'
import { supportsOtherPartyCapture } from '@renderer/lib/platform'
import type { LiveStatus } from './types'
import type { CallSegment, ConsentRecord } from '@renderer/features/calls/types'
import type { TranscriptionHealthEvent } from '../../../../preload/index.d'
import {
  getAutoSummarize,
  getAutoGenerateTitle,
  getAutoPostCallBrief,
  addSeenApp
} from '@renderer/features/settings/prefs'

type LivePhase = Exclude<LiveStatus, 'paused'>

/** Starting takes longer than this → show an interstitial rather than leaving
 *  the rep staring at an unchanged screen. */
const SLOW_START_MS = 400
/** The microphone check is still pending after this → a real OS prompt is up. */
const MIC_PROMPT_MS = 250

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
  /** 1Hz session-health snapshot, or null before the first tick. */
  health: TranscriptionHealthEvent | null
  /** True only while the OS microphone permission prompt is actually showing. */
  micPrompting: boolean
  /** True once the post-call brief + follow-up email are on the clipboard. */
  briefCopied: boolean
  /** True once main has spotted "mic live, buyer bit-silent" long enough to
   *  look like the Windows endpoint bug (docs/windows-capture.md, §7). */
  buyerSilentWarning: boolean
  dismissBuyerSilentWarning: () => void
  /** M19 Task 2 Part A — Deepgram's claimed channel disagreed with actual
   *  audio energy (the loudspeaker/echo signature). Advisory. */
  crossTalkWarning: boolean
  dismissCrossTalkWarning: () => void
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
}

export function useTranscription(
  consentRef?: { current: ConsentRecord },
  onStartReset?: () => void,
  /** AI Note Taker's "auto-open meeting page" — fired with the saved call's
   *  id after every successful save. Kept in a ref so it's always current
   *  without forcing flushPendingSave to be recreated on every render. */
  onSaved?: (callId: string) => void,
  /** M19 Task 2 step 5 — set by useLiveCues (a sibling hook, so this can
   *  only be a ref bridge, not a hook argument) when the buyer's self-intro
   *  resolves live. Read once, at save time, so it's not lost with the rest
   *  of the in-progress session's local state. */
  buyerIdentityRef?: { current: { key: string; name: string } | null }
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
  const [health, setHealth] = useState<TranscriptionHealthEvent | null>(null)
  // The zero-native-code Windows endpoint-bug mitigation (§7): main flags
  // "mic live, buyer bit-silent" and this is what turns it into a banner. Null
  // once dismissed OR once the underlying condition clears — see onClosed.
  const [buyerSilentWarning, setBuyerSilentWarning] = useState(false)
  /** M19 Task 2 Part A — Deepgram's claimed channel disagreed with actual
   *  per-channel audio energy at least once (the loudspeaker/echo
   *  signature). Advisory only — no reassignment happens, just a "you may
   *  want headphones" nudge. */
  const [crossTalkWarning, setCrossTalkWarning] = useState(false)
  /** True only while the OS microphone prompt is genuinely pending, so the
   *  startup copy can name it instead of guessing. */
  const [micPrompting, setMicPrompting] = useState(false)
  /** True once a post-call brief has been written to the clipboard. */
  const [briefCopied, setBriefCopied] = useState(false)

  const recorderRef = useRef<Recorder | null>(null)
  // Id of the main-process session THIS call owns. Passed as expectedSessionId
  // on the mono<->multichannel restarts so a stale in-flight toggle from an
  // already-stopped call can never tear down a newer call's session.
  const sessionIdRef = useRef<number | null>(null)
  // Re-entrancy guard: a rapid double-click on Try again/Resume must not run
  // two arm-then-getDisplayMedia sequences concurrently.
  const startingRef = useRef(false)
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
      .save(
        {
          startedAt: startedAtRef.current,
          durationMs: durationMsRef.current,
          segments: captured,
          // Consent captured during the session; the main process re-sanitizes it
          // and enforces the "no consent = no capture" invariant on save.
          consent: consentRef?.current
        },
        buyerIdentityRef?.current ?? undefined
      )
      .then((saved) => {
        setSavedNotice(true)
        // AI Note Taker: fire-and-forget the opted-in auto-behaviors. Each is
        // independent — one failing (or being off) never affects the others.
        if (getAutoSummarize()) void window.api.calls.summarizeCall(saved.id).catch(() => {})
        if (getAutoGenerateTitle()) void window.api.calls.generateTitle(saved.id).catch(() => {})
        // §4.6 — the brief lands on the clipboard without anyone clicking.
        // Main does the clipboard write, so this works while the rep is still
        // looking at Zoom and our window has no focus.
        if (getAutoPostCallBrief()) {
          void window.api.calls
            .postCallBrief(saved.id)
            .then((res) => {
              if (res.ok && res.copied) setBriefCopied(true)
            })
            .catch(() => {})
        }
        onSavedRef.current?.(saved.id)
      })
      .catch(() => {
        /* non-fatal: the transcript is still on screen */
      })
  }, [consentRef, buyerIdentityRef])

  useEffect(() => {
    const offState = window.api.transcription.onState((payload) => {
      if (payload.state === 'listening') setPhase('listening')
      else if (payload.state === 'connecting') setPhase('connecting')
      else if (payload.state === 'reconnecting') setPhase('reconnecting')
      else if (payload.state === 'error') {
        setPhase('error')
        setPaused(false)
        setOtherPartyLive(false)
        setBuyerSilentWarning(false)
        setCrossTalkWarning(false)
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
      setBuyerSilentWarning(false)
      setCrossTalkWarning(false)
      savePendingRef.current = false
      recorderRef.current?.stop()
      recorderRef.current = null
      setAnalyser(null)
    })

    // Audio that will never be transcribed. Recorded inline so the transcript
    // never silently splices two moments that are minutes apart — an honest
    // hole is far more useful than a seamless-looking lie.
    const offGap = window.api.transcription.onGap((payload) => {
      // Speaker 0 rather than a sentinel: the main-process sanitizer clamps
      // speaker ids to >= 0, so a sentinel would not survive a save anyway.
      // Everything that matters keys off `kind`, never the id.
      const marker: CallSegment = { speaker: 0, text: payload.marker, kind: 'gap' }
      segmentsRef.current = [...segmentsRef.current, marker]
      setSegments(segmentsRef.current)
      // Whatever comes next is a fresh turn, not a continuation of what the
      // gap interrupted.
      speakerBoundaryRef.current = true
    })

    const offHealth = window.api.transcription.onHealth((payload) => {
      setHealth(payload)
    })

    const offBuyerSilent = window.api.transcription.onBuyerSilent(() => {
      setBuyerSilentWarning(true)
    })

    // M19 Task 2 Part A — Deepgram's claimed channel disagreed with actual
    // per-channel energy for a finalized utterance. The main-process gate
    // can fire this repeatedly through a sustained cross-talk stretch;
    // React bails out on an identical setState, so the banner just stays up
    // rather than re-rendering per utterance.
    const offCrossTalk = window.api.transcription.onCrossTalkWarning(() => {
      setCrossTalkWarning(true)
    })

    // Main's liveness watchdog noticed no audio callback at all for 10s while
    // the session was live (session-health.md calls this "capture-dead →
    // reacquire") — the capture device is gone even though nothing at the
    // browser level (the mic track's own 'ended' event) said so. Recovers the
    // same way an unplugged mic does: end the session and surface the
    // existing "Microphone disconnected" / Reconnect flow rather than leaving
    // the rep on a call that main can see has gone silent forever.
    const offCaptureLost = window.api.transcription.onCaptureLost(() => {
      armSave()
      recorderRef.current?.stop()
      recorderRef.current = null
      setAnalyser(null)
      setOtherPartyLive(false)
      setBuyerSilentWarning(false)
      setCrossTalkWarning(false)
      void window.api.transcription.stop()
      setPhase('no-device')
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
      offGap()
      offHealth()
      offBuyerSilent()
      offCrossTalk()
      offCaptureLost()
      offClosed()
    }
  }, [armSave, flushPendingSave])

  const beginSession = useCallback(async (): Promise<void> => {
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
    setHealth(null)
    setBuyerSilentWarning(false)
    setCrossTalkWarning(false)
    setBriefCopied(false)
    segmentsRef.current = []
    latencySamples.current = []
    savePendingRef.current = false
    sessionIdRef.current = null

    // Starting a call used to swap the whole screen twice in under a second:
    // hero → a full-page "Requesting microphone access… Approve the prompt to
    // begin." → the call UI. On the overwhelmingly common path the permission
    // is ALREADY granted, so no prompt ever appears and that middle screen was
    // both a flash and a lie.
    //
    // So it is now earned rather than assumed: nothing changes for the first
    // 400ms, and the interstitial only appears if starting genuinely takes long
    // enough to need feedback. Its copy names the microphone prompt only when a
    // prompt is really pending.
    const settleTimer = setTimeout(() => setPhase('requesting'), SLOW_START_MS)
    const promptTimer = setTimeout(() => {
      setMicPrompting(true)
      setPhase('requesting')
    }, MIC_PROMPT_MS)
    const finishStartup = (): void => {
      clearTimeout(settleTimer)
      clearTimeout(promptTimer)
      setMicPrompting(false)
    }

    let access: { status: string }
    try {
      access = await window.api.transcription.ensureMicAccess()
    } catch {
      finishStartup()
      setPhase('error')
      setErrorMessage('Could not check microphone access. Please try again.')
      return
    }
    clearTimeout(promptTimer)
    setMicPrompting(false)
    if (access.status !== 'granted') {
      finishStartup()
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
          setBuyerSilentWarning(false)
          setCrossTalkWarning(false)
          void window.api.transcription.stop()
          setPhase('no-device')
        },
        (frames) => window.api.transcription.reportAudioDropped(frames)
      )
    } catch (err) {
      finishStartup()
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

    finishStartup()
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

  const start = useCallback(async () => {
    // The screen no longer changes the instant Start is pressed (see the
    // startup-interstitial note below), so the button that triggered this is
    // still on screen and still clickable. Without this guard a double-click
    // would open two microphones and two sockets.
    if (startingRef.current) return
    startingRef.current = true
    try {
      await beginSession()
    } finally {
      startingRef.current = false
    }
  }, [beginSession])

  const getSessionId = useCallback(() => sessionIdRef.current, [])

  const stop = useCallback(async () => {
    armSave()
    recorderRef.current?.stop() // also detaches any loopback
    recorderRef.current = null
    setAnalyser(null)
    setPaused(false)
    setOtherPartyLive(false)
    setOtherPartyError(null)
    setBuyerSilentWarning(false)
    setCrossTalkWarning(false)
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
      // Whatever prompted the buyer warning no longer applies once buyer
      // capture itself has been turned off — a stale "audio has been silent,
      // check your routing" banner about a channel that's no longer running
      // reads as contradicting whatever banner explains WHY it stopped.
      setBuyerSilentWarning(false)
      setCrossTalkWarning(false)
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
          setBuyerSilentWarning(false)
          setCrossTalkWarning(false)
          return
        }
        audio = new MediaStream(display.getAudioTracks())
      } catch {
        window.api.loopback.disarm()
        setOtherPartyError('denied')
        setBuyerSilentWarning(false)
        setCrossTalkWarning(false)
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
        setBuyerSilentWarning(false)
        setCrossTalkWarning(false)
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
        setBuyerSilentWarning(false)
        setCrossTalkWarning(false)
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
    health,
    micPrompting,
    briefCopied,
    buyerSilentWarning,
    dismissBuyerSilentWarning: useCallback(() => setBuyerSilentWarning(false), []),
    crossTalkWarning,
    dismissCrossTalkWarning: useCallback(() => setCrossTalkWarning(false), []),
    start,
    getSessionId,
    stop,
    togglePause,
    enableOtherParty,
    disableOtherParty
  }
}
