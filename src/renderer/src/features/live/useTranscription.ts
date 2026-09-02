import { useCallback, useEffect, useRef, useState } from 'react'
import { startRecorder, type Recorder } from './audio/recorder'
import { supportsOtherPartyCapture } from '@renderer/lib/platform'
import type { LiveStatus } from './types'
import type { CallSegment, ConsentRecord } from '@renderer/features/calls/types'
import type {
  AttachSnapshot,
  TranscriptPatch,
  TranscriptionHealthEvent
} from '../../../../preload/index.d'
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

/** Process-wide, monotonic. Every Recorder gets one, and main only accepts
 *  audio tagged with the id the current session was started for — so a
 *  Recorder that outlives its call cannot feed the next one. Module scope (not
 *  a ref) because the identity must be unique across every mount of this hook,
 *  not just within one. See StartOptions.producerId in main/transcription.ts. */
let nextProducerId = 1

/** BUG-172 — 'not-ready' is the state that had no name, and that is why the
 *  failure was silent for six weeks. The auto-attach effect fires the moment
 *  the socket says 'listening', which on a COLD LAUNCH is before the call
 *  record exists — so `getCallId()` is still null, `consent.persist` is handed
 *  an empty id and returns false, and the effect returned having already spent
 *  its one attempt per call. No error was set, so no banner offered a retry,
 *  and the call recorded ONLY THE REP for its whole duration while
 *  `consent.recordOtherParty` said true. Nineteen calls on the founder's
 *  machine back to 2026-07-17. */
export type OtherPartyError = 'denied' | 'no-audio' | 'interrupted' | 'not-ready' | null

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
  /** BUG-172 — set when the call id never arrived, so the rep is told the
   *  buyer is not being captured rather than finding out from the transcript. */
  setOtherPartyNotReady: () => void
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
  /** M22 — main dropped buyer capture mid-call because it kept needing lag
   *  corrections faster than they could recover (a sustained deficit, not a
   *  one-off blip). The call continues mic-only; this just explains why. */
  multichannelFallbackNotice: boolean
  dismissMultichannelFallbackNotice: () => void
  start: () => Promise<void>
  /** The main-process transcription session id for the call in progress, or
   *  null before a session exists / after a failed start. A function (not a
   *  plain value) so callers always read the freshest ref, regardless of
   *  whether a re-render has happened since the last change. */
  getSessionId: () => number | null
  /** M26 4.5 — the CALL id (`live-transcript.ts`'s journal id), distinct from
   *  the session id above: a mono<->multichannel restart mints a new session
   *  id but is the SAME call (see `beginCall({restart: true})`), while this
   *  stays stable across it. Exists so other engines hoisted alongside this
   *  one (cue/deal-intelligence) can tell "this is genuinely a new call,
   *  reset" apart from "the same call's status merely blipped" — the
   *  distinction `status`/`active` alone cannot make. A function for the same
   *  reason as getSessionId: always the freshest value, not a stale render. */
  getCallId: () => string | null
  stop: () => Promise<void>
  /** BUG-152 — clear a finished call off the Live screen and return to idle.
   *  Saves first; only ever called from a terminal status. */
  dismissFinishedCall: () => void
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

  // M26 4.3 — 'attaching', never 'idle'. Main owns the transcript now, so a
  // freshly mounted Live view does not know whether a call is running until it
  // asks. Starting at 'idle' would flash "Start a call" during a real call.
  const [phase, setPhase] = useState<LivePhase>('attaching')
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
  /** M22 — set once when main signals it dropped buyer capture because the
   *  connection couldn't sustain it (see onMultichannelFallback below). */
  const [multichannelFallbackNotice, setMultichannelFallbackNotice] = useState(false)
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
  // The producer id of the Recorder this call owns. Sent with every audio
  // chunk and on the mono<->multichannel restarts (same recorder, so same
  // producer — omitting it there would silently disable the guard for the
  // rest of any call that touches buyer capture).
  const producerIdRef = useRef<number | null>(null)
  // Re-entrancy guard: a rapid double-click on Try again/Resume must not run
  // two arm-then-getDisplayMedia sequences concurrently.
  const startingRef = useRef(false)
  const enablingOtherPartyRef = useRef(false)
  // Same guard, mirrored for the disable path — defense in depth alongside
  // the natural isLoopbackAttached() idempotency check below.
  const disablingOtherPartyRef = useRef(false)
  const latencySamples = useRef<number[]>([])
  // Synchronous mirror of `segments` so the save (on close) sees the latest.
  //
  // M26 4.3 — this is now a MIRROR of main's transcript rather than the
  // original. Nothing in the renderer appends to it; it is rebuilt from the
  // patches main sends. It is still what `flushPendingSave` inspects to decide
  // WHETHER anything was said worth saving (BUG-053's gate), but main
  // substitutes its own copy for the bytes that actually get written.
  const segmentsRef = useRef<CallSegment[]>([])
  /** Which call the mirror currently holds, so a patch for a different call is
   *  recognisable rather than spliced into the wrong transcript. */
  const mirrorCallIdRef = useRef<string | null>(null)
  /** The last patch sequence applied. A gap means one was missed, which is the
   *  one failure that would otherwise diverge the two copies silently. */
  const seqRef = useRef<number>(-1)
  /** Patches that arrived before attach resolved. Subscribing first and
   *  buffering is what closes the window where a patch would be dropped
   *  because the snapshot had not come back yet. */
  const pendingPatchesRef = useRef<TranscriptPatch[]>([])
  const attachedRef = useRef(false)
  const startedAtRef = useRef<string>('')
  const startMsRef = useRef<number>(0)
  const durationMsRef = useRef<number>(0)
  const savePendingRef = useRef(false)
  // Which speaker label is the REP, per label namespace. Multichannel fills
  // this in immediately (channel 0 is the rep by construction); under
  // diarization it stays empty until the coaching engine identifies them, and
  // turns recorded before that are honestly marked 'unknown' rather than
  // guessed. Keyed by epoch so a reconnect can't carry a stale answer over.
  const repByEpochRef = useRef<Map<number, number>>(new Map())
  /**
   * Called once the coaching engine identifies the rep under diarization.
   *
   * M26 4.3 — this now only REPORTS. Main owns the transcript, so main does
   * the back-fill (only turns still 'unknown' in that same epoch, never ones
   * Deepgram left unlabelled) and sends the relabelled turns back as a patch.
   * The map kept here exists purely to avoid re-sending an answer main
   * already has.
   */
  const identifyRep = useCallback((epoch: number, speaker: number) => {
    if (repByEpochRef.current.get(epoch) === speaker) return
    repByEpochRef.current.set(epoch, speaker)
    // M26 Phase 4.2 — tell main, which keeps its own journaled copy of this
    // call. Who the rep is comes back from the coaching engine and is known
    // only here, so main cannot derive it (unlike gaps and speaker
    // boundaries, which it can and does). Without this a recovered transcript
    // is still complete, but every turn reads 'unknown' instead of rep/other.
    // Fire-and-forget on purpose: a failure here must never affect the call.
    window.api.live.repIdentified(epoch, speaker)
  }, [])

  // Arm a save (used by Stop, mic-unplug, and the unmount cleanup below, so
  // they can't drift).
  //
  // BUG-053 — this latch records INTENT ONLY: "a save has been requested".
  // It used to also decide, right here, whether there was anything worth
  // saving (`= segmentsRef.current.length > 0`), and that check was made at
  // the wrong moment. Stopping a call sends Deepgram a Finalize and keeps
  // the socket open ~1.5s specifically so the last words still arrive
  // (main/transcription.ts's STOP_FLUSH_MS) — so on a SHORT call, where
  // everything spoken was still interim at the moment Stop was pressed,
  // this latched false, the final words then landed in segmentsRef, and
  // flushPendingSave bailed on a call that did have content. The rep did
  // exactly the right thing and lost the call through the primary button.
  //
  // "Is there anything to save?" is answered where it belongs — in
  // flushPendingSave, against segmentsRef AT FLUSH TIME, after the final
  // words have arrived. A genuinely wordless call still writes nothing.
  const armSave = useCallback(() => {
    durationMsRef.current = startMsRef.current
      ? Math.round(performance.now() - startMsRef.current)
      : 0
    savePendingRef.current = true
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

  /**
   * M26 4.3 — find out whether a call is already in progress, and mirror it.
   *
   * THE RULE THIS EXISTS TO ENFORCE: the idle screen may only appear once main
   * has affirmatively said there is no session. Never on a timeout, never as a
   * default, never because an answer is slow. A rep who navigates back into a
   * live call and sees "Start a call" reads it as "my call died" — so the
   * failure path here is `error`, and the pending path is `attaching`, and
   * neither is ever `idle`.
   */
  const hydrate = useCallback((snapshot: AttachSnapshot): void => {
    if (snapshot.call) {
      const segs = snapshot.call.segments as CallSegment[]
      segmentsRef.current = segs
      mirrorCallIdRef.current = snapshot.call.callId
      seqRef.current = snapshot.call.seq
      setSegments(segs)
      startedAtRef.current = snapshot.call.startedAt
      // Rebase the local clock onto main's start, so a view that attached
      // 30 minutes into a call reports 30 minutes rather than zero.
      startMsRef.current = performance.now() - (Date.now() - snapshot.call.startedAtMs)
    } else {
      segmentsRef.current = []
      mirrorCallIdRef.current = null
      seqRef.current = -1
      setSegments([])
    }
    if (snapshot.session) {
      sessionIdRef.current = snapshot.session.id
      producerIdRef.current = snapshot.session.producerId
      setPhase(snapshot.session.state === 'idle' ? 'idle' : snapshot.session.state)
    } else {
      // The single affirmative "there is no call" answer in the whole system.
      setPhase('idle')
    }
  }, [])

  const reattach = useCallback(async (): Promise<void> => {
    try {
      hydrate(await window.api.transcription.attach())
    } catch {
      setErrorMessage('Lost track of the call in progress. Reopen this screen to try again.')
      setPhase('error')
    }
  }, [hydrate])

  const applyPatch = useCallback((patch: TranscriptPatch): void => {
    // A patch for a call this mirror is not holding is only safe to accept if
    // it is a call-start reset; anything else means we missed a boundary.
    if (patch.callId !== mirrorCallIdRef.current) {
      if (patch.seq !== 0 || patch.from !== 0) {
        void reattach()
        return
      }
      mirrorCallIdRef.current = patch.callId
      seqRef.current = -1
    }
    if (patch.seq !== seqRef.current + 1) {
      // A missed or reordered patch. Re-ask for the whole thing rather than
      // splice into a transcript we can no longer prove is correct — a wrong
      // transcript that looks fine is far worse than one extra round-trip.
      void reattach()
      return
    }
    const next = [...segmentsRef.current.slice(0, patch.from), ...patch.segments] as CallSegment[]
    segmentsRef.current = next
    seqRef.current = patch.seq
    setSegments(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    // Subscribe BEFORE asking, so a patch produced while the snapshot is in
    // flight is buffered rather than lost.
    const off = window.api.transcription.onSegments((patch) => {
      if (cancelled) return
      if (!attachedRef.current) {
        pendingPatchesRef.current.push(patch)
        return
      }
      applyPatch(patch)
    })

    void (async () => {
      let snapshot: AttachSnapshot
      try {
        snapshot = await window.api.transcription.attach()
      } catch {
        if (cancelled) return
        // NOT idle. We do not know whether a call is running, and saying
        // "no call" when we cannot tell is the exact lie this guards against.
        setErrorMessage('Could not check for a call in progress.')
        setPhase('error')
        attachedRef.current = true
        return
      }
      if (cancelled) return
      hydrate(snapshot)
      attachedRef.current = true
      const buffered = pendingPatchesRef.current
      pendingPatchesRef.current = []
      for (const patch of buffered) {
        // Anything already contained in the snapshot is a duplicate.
        if (patch.callId === mirrorCallIdRef.current && patch.seq <= seqRef.current) continue
        applyPatch(patch)
      }
    })()

    return () => {
      cancelled = true
      attachedRef.current = false
      off()
    }
  }, [applyPatch, hydrate])

  useEffect(() => {
    const offState = window.api.transcription.onState((payload) => {
      if (payload.state === 'listening') setPhase('listening')
      else if (payload.state === 'connecting') setPhase('connecting')
      else if (payload.state === 'reconnecting') setPhase('reconnecting')
      // M26 4.3 — main says the call is over. Previously dropped on the floor,
      // which meant the renderer could only reach idle by assuming it.
      else if (payload.state === 'idle') setPhase('idle')
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
        // M26 4.3 — the transcript is NOT built here any more. Main
        // accumulates it and sends back deltas (see the attach effect above).
        // What is left in this subscription is only what is genuinely
        // renderer-local: the faint in-progress line and the latency meter.
        //
        // Interim results still arrive here and still matter — battlecards
        // match against the rolling partial, long before anything finalizes —
        // which is why this channel stays alongside the patch channel rather
        // than being collapsed into it.
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
    setMultichannelFallbackNotice(false)
    setBriefCopied(false)
    segmentsRef.current = []
    latencySamples.current = []
    savePendingRef.current = false
    sessionIdRef.current = null
    // Per-CALL state, and this hook instance outlives a single call (LiveView
    // stays mounted between them) — reset so the rep identified in a PREVIOUS
    // call's epoch(s) can never be assumed for a new one.
    repByEpochRef.current = new Map()

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

    // A Recorder from a previous take must never survive into this one: it
    // holds a live mic and its worklet is still posting PCM into sendAudio.
    // Every caller is *supposed* to have stopped it already, but that
    // invariant was spread across five separate call sites with no guard
    // here — and two paths below (the post-await supersession checks) could
    // abandon one outright. stop() is idempotent, so this is safe even when
    // the ref is already clean.
    recorderRef.current?.stop()
    recorderRef.current = null

    const producerId = nextProducerId++
    producerIdRef.current = producerId

    let recorder: Recorder
    try {
      recorder = await startRecorder(
        (chunk) => window.api.transcription.sendAudio(chunk, producerId),
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
        (frames) => window.api.transcription.reportAudioDropped(frames, producerId)
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

    // Stop (or another terminal path) may have landed while startRecorder was
    // still awaiting. recorderRef was null for that whole window, so nothing
    // could tear THIS recorder down — installing it now would leave a live mic
    // and a running worklet attached to a call that is already over, and it
    // would keep posting PCM into whatever session starts next.
    if (producerIdRef.current !== producerId) {
      recorder.stop()
      finishStartup()
      return
    }

    finishStartup()
    recorderRef.current = recorder
    setAnalyser(recorder.analyser)
    startedAtRef.current = new Date().toISOString()
    startMsRef.current = performance.now()
    setPhase('connecting')

    try {
      const result = await window.api.transcription.start({
        sampleRate: recorder.sampleRate,
        producerId
      })
      // The rep may have clicked Stop while this awaited the real Deepgram
      // handshake — stop() nulls recorderRef.current synchronously, so this
      // is the same "was I superseded" check enable/disableOtherParty already
      // use after their own awaits (M22 bug hunt: this one was missing here).
      // Without it, a stale failure would snap the UI to an error/no-key
      // screen for a call the rep already left, and a stale success would
      // silently leave main's session running with no recorder ever attached
      // to drive it — startingRef.current stays true for this whole
      // beginSession call, so no OTHER start() could have raced in and made
      // this session id stale in some other way; it's this call's own.
      if (recorderRef.current !== recorder) {
        // Stop the recorder THIS call built before walking away from it.
        // Without this it is orphaned: mic still open, AudioContext still
        // running, worklet still posting PCM — and unreachable, so nothing
        // can ever stop it again. Two live producers against Deepgram's
        // ingest cap is the unbounded-lag bug.
        recorder.stop()
        if (result.ok) void window.api.transcription.stop()
        return
      }
      if (!result.ok) {
        recorder.stop()
        recorderRef.current = null
        setAnalyser(null)
        setPhase(result.error === 'no-key' ? 'no-key' : 'error')
      } else {
        sessionIdRef.current = typeof result.sessionId === 'number' ? result.sessionId : null
      }
    } catch {
      if (recorderRef.current !== recorder) {
        recorder.stop() // same orphan-prevention as the supersession check above
        return
      }
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

  /**
   * BUG-152 — leave a finished call's screen.
   *
   * A call that ends WITHOUT the rep pressing Stop (the watchdog's
   * onCaptureLost sets 'no-device') leaves the transcript on screen with only
   * a "Reconnect" button, which starts a NEW call. LiveView's
   * `if (!hasTranscript)` gate skips every full-screen state once a transcript
   * exists, so there is no route back to the start screen at all.
   *
   * flushPendingSave FIRST, always: the whole reason the transcript is kept on
   * screen after a call is that the save may still be pending, and clearing
   * before it lands would destroy the call. This only ever runs from a
   * terminal status (see post-call-exit.ts), so nothing is being captured.
   */
  const dismissFinishedCall = useCallback(() => {
    flushPendingSave()
    setSegments([])
    setInterimText('')
    setSavedNotice(false)
    setErrorMessage(null)
    setPhase('idle')
  }, [flushPendingSave])

  const getSessionId = useCallback(() => sessionIdRef.current, [])
  const getCallId = useCallback(() => mirrorCallIdRef.current, [])

  const stop = useCallback(async () => {
    armSave()
    recorderRef.current?.stop() // also detaches any loopback
    recorderRef.current = null
    // Renounce the producer claim too. If a beginSession is mid-flight inside
    // `await startRecorder(...)`, recorderRef is still null — so the stop above
    // cannot reach the recorder being built. Clearing this is what tells that
    // beginSession, when it resumes, that it was superseded and must throw its
    // recorder away rather than install a live capture pipeline into a call the
    // rep already ended (which would then feed the NEXT session).
    producerIdRef.current = null
    setAnalyser(null)
    setPaused(false)
    setOtherPartyLive(false)
    setOtherPartyError(null)
    setBuyerSilentWarning(false)
    setCrossTalkWarning(false)
    const res = await window.api.transcription.stop()
    setInterimText('')
    // M26 4.3 — idle only because main SAID there is no session, never merely
    // because we asked it to stop. Same rule as attach: this screen does not
    // get to assume a call has ended.
    if (res?.session === null) setPhase('idle')
    // segments stay on screen after stopping; save fires on 'closed'.
  }, [armSave])

  const togglePause = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder) return
    setPaused((prev) => {
      const next = !prev
      recorder.setPaused(next)
      // BUG-111 — main cannot infer this. Pause simply stops handing chunks to
      // sendAudio, which from main's side is indistinguishable from the
      // microphone dying, and after noAudioMs its liveness watchdog declared
      // capture-dead — which ended and SAVED the call and dropped the rep on
      // "Microphone disconnected". Telling main explicitly is the whole fix.
      window.api.transcription.setPaused(next, producerIdRef.current ?? undefined)
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
      // Switch the socket back to mono FIRST, then flip the worklet layout — so
      // the worklet never emits mono into the still-open multichannel socket.
      // expectedSessionId makes this a no-op in main if it lands after a newer
      // call already replaced the session (never clobber the new call).
      let ok = false
      try {
        const res = await window.api.transcription.start({
          sampleRate: recorder.sampleRate,
          multichannel: false,
          expectedSessionId: sessionIdRef.current ?? undefined,
          // Same recorder, so same producer — main replaces the session, and a
          // session started without this id would accept ANY producer for the
          // rest of the call, silently disabling the orphan guard.
          producerId: producerIdRef.current ?? undefined
        })
        ok = res?.ok === true
        if (ok && typeof res.sessionId === 'number') sessionIdRef.current = res.sessionId
      } catch {
        ok = false
      }
      // The call may have stopped (or restarted) during the await — this recorder
      // is then already torn down and mustn't be touched.
      if (recorderRef.current !== recorder) return
      // Only flip the worklet once the socket really IS mono — mirroring what
      // enableOtherParty already does for the other direction. Flipping it after
      // a failed restart ('stale'/'no-key') leaves a mono worklet feeding a
      // still-multichannel socket, so every frame is counted as half its real
      // duration and the transcript garbles.
      if (ok) recorder.setStereo(false)
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
          expectedSessionId: sessionIdRef.current ?? undefined,
          // Same recorder, so same producer (see disableOtherParty).
          producerId: producerIdRef.current ?? undefined
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
      recorder.setStereo(true)
      setOtherPartyLive(true)
    } finally {
      enablingOtherPartyRef.current = false
    }
  }, [consentRef, disableOtherParty])

  // M22 — main decided buyer capture can't keep up in real time on this
  // connection (repeated lag corrections that kept coming back faster than
  // they could recover — a sustained deficit, not a network blip) and wants
  // it dropped. Mechanically identical to the rep manually turning buyer
  // capture off: `disableOtherParty` already only touches capture, never the
  // recorded consent, so nothing here needs to re-prompt if the rep manually
  // re-enables it later in the same call.
  useEffect(() => {
    const off = window.api.transcription.onMultichannelFallback(() => {
      setMultichannelFallbackNotice(true)
      void disableOtherParty()
    })
    return off
  }, [disableOtherParty])

  useEffect(() => {
    return () => {
      // BUG-046: this cleanup also runs when the rep merely navigates to a
      // different screen mid-call (LiveView unmounts on every nav change,
      // not just on a real hangup) — not only on an actual Stop click. A
      // live recorder here means the call was never stopped, so the
      // transcript captured so far would otherwise be silently discarded:
      // arm the save exactly as the Stop button does before anything is
      // torn down. An idle/errored/already-stopped call has no recorder
      // left (stop()/onError/captureLost/mic-unplug all null it), so this
      // can never re-arm — and therefore never duplicate-save — a call that
      // already finished saving.
      if (recorderRef.current) armSave()
      // Save a stopped-but-not-yet-flushed call before tearing down.
      flushPendingSave()
      recorderRef.current?.stop()
      recorderRef.current = null
      void window.api.transcription.stop()
    }
  }, [armSave, flushPendingSave])

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
    otherPartyLive,
    otherPartyError,
    health,
    micPrompting,
    briefCopied,
    buyerSilentWarning,
    dismissBuyerSilentWarning: useCallback(() => setBuyerSilentWarning(false), []),
    crossTalkWarning,
    dismissCrossTalkWarning: useCallback(() => setCrossTalkWarning(false), []),
    /** BUG-172 — LiveView calls this when the call id never arrived, so the
     *  rep is told the buyer is not being captured instead of finding out from
     *  the transcript afterwards. */
    setOtherPartyNotReady: useCallback(() => setOtherPartyError('not-ready'), []),
    multichannelFallbackNotice,
    dismissMultichannelFallbackNotice: useCallback(() => setMultichannelFallbackNotice(false), []),
    start,
    getSessionId,
    getCallId,
    stop,
    dismissFinishedCall,
    togglePause,
    enableOtherParty,
    disableOtherParty
  }
}
