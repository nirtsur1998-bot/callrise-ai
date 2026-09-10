// M26 Phase 4.4 — Recorder ownership, hoisted above the navigation boundary.
//
// THE PROBLEM THIS SOLVES. Before this file existed, `LiveView` called
// `useTranscription()` (and `useConsent()`) directly, so the entire capture
// pipeline — `getUserMedia`, the `AudioContext`, the `AudioWorklet`, buyer-
// capture loopback, the analyser driving the waveform — lived inside a
// component `MainApp` unmounts on every navigation (`key={active}` on the
// content div, and an entirely separate returned tree for Settings). 4.1–4.3
// already moved the TRANSCRIPT out of that lifecycle into main; this moves
// the CAPTURE SESSION out of it too, in the renderer, the only place it can
// live (there is no main-process microphone API — see the design doc's
// "What I am NOT touching").
//
// WHY A CONTEXT PROVIDER, NOT JUST "MOVE THE RECORDER OBJECT". A Recorder-
// only hoist was tried on paper first and rejected: `armSave()` and
// `flushPendingSave()` — the BUG-046 hotfix — live inside `useTranscription`,
// not inside the raw Recorder. As long as `useTranscription()` itself was
// still instantiated inside `LiveView`, those lines would still fire on every
// ordinary navigation regardless of where the Recorder object physically
// lived, and swapping their trailing `stop()` for `detach()` in that state
// would SAVE A CALL THAT IS STILL RUNNING on every nav-away — worse than
// today, not better. The only thing that actually stops "screen unmounts" and
// "call ends" from being the same event is un-coupling the HOOK INSTANCE
// itself from the screen. Hence: hoist the whole instantiation into a
// Provider mounted once, above `MainApp`.
//
// NOT A NEW PATTERN FOR THIS CODEBASE. `ToastProvider`
// (features/notifications/ToastProvider.tsx) already does exactly this shape
// — one Provider instantiated once in App.tsx, descendants read it via a
// hook — for the same reason: state that must outlive whichever screen
// happens to be showing. This file follows its context/component split too
// (useLiveCall.ts has the context + hook; this file has only the component),
// which Fast Refresh requires of any file that exports a component.
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useConsent } from '@renderer/features/consent/useConsent'
import { useAppSettings } from '@renderer/features/settings/useAppSettings'
import type { CalendarEvent } from '@renderer/features/calendar/types'
import { useCueSettings } from './useCueSettings'
import { useLiveCues } from './useLiveCues'
import { useDealIntelligenceSettings } from '@renderer/features/deal-intelligence/useDealIntelligenceSettings'
import { useDealIntelligence } from '@renderer/features/deal-intelligence/useDealIntelligence'
import { useTranscription } from './useTranscription'
import { LiveCallContext, type LiveCallContextValue } from './useLiveCall'

interface BuyerIdentity {
  key: string
  name: string
}

export function LiveCallProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // Standing consent has to be known before useConsent builds the call's
  // opening record, same reasoning LiveView used to carry directly (see
  // useConsent's own doc comment) — just evaluated here now, since this is
  // where useConsent itself lives.
  const appSettings = useAppSettings().settings
  const standingConsent =
    appSettings.allowOtherPartyRecording && appSettings.alwaysRecordOtherParty

  const consent = useConsent(standingConsent)
  const buyerIdentityRef = useRef<BuyerIdentity | null>(null)

  const onSavedRef = useRef<((callId: string) => void) | null>(null)
  // Stable identity for the whole app lifetime — useTranscription's own
  // onSavedRef effect (`useEffect(() => { onSavedRef.current = onSaved },
  // [onSaved])`) therefore only ever runs once, at Provider mount, exactly as
  // intended: the ACTUAL callback can still change freely underneath it via
  // setOnSaved below, without touching useTranscription at all.
  const onSaved = useCallback((callId: string) => {
    onSavedRef.current?.(callId)
  }, [])
  const setOnSaved = useCallback((cb: ((callId: string) => void) | null) => {
    onSavedRef.current = cb
  }, [])

  const transcription = useTranscription(consent.recordRef, consent.reset, onSaved, buyerIdentityRef)

  // M26 4.5 (BUG-055) — hoisted alongside the transcript, for the same
  // reason and the same way: both engines' timing-dependent state (the
  // interrupt channel's cooldown, Deal Intelligence's nudge history and
  // health-score baseline) must survive a screen navigation, and — this is
  // the part a Recorder-only-style hoist would have missed — an ordinary
  // mid-call mono<->multichannel restart too. `getCallId` (not `status`) is
  // what lets both hooks tell those apart from a genuine new call; see their
  // own reset-effect comments for the full story.
  // LiveView's own calendar-matched "what's happening right now" — genuinely
  // screen-local (needs useCalendar()) — bridged in via a plain setter,
  // mirroring setOnSaved's shape but for a value useDealIntelligence reacts
  // to reactively rather than reads once at save time.
  //
  // BUG-222 — HOISTED above useLiveCues so the cue prompt can carry the client.
  // The state is unchanged; what is new is its position and the ref beside it.
  //
  // REF-BACKED, and that is the whole care in this change.
  // `getMeetingContactId` is a useCallback([]) reading a ref, so its identity
  // NEVER changes. Passing `currentMeeting` itself, or a callback closed over
  // it, would change identity the moment a meeting resolves — re-running the
  // cue effect mid-call. That re-run is BUG-055: it wipes the interrupt
  // channel's cooldown and dedupe state, which is what let an already-
  // suppressed cue fire again the moment a blip passed.
  const currentMeetingRef = useRef<CalendarEvent | null>(null)
  const [currentMeeting, setCurrentMeetingState] = useState<CalendarEvent | null>(null)
  const setCurrentMeeting = useCallback((meeting: CalendarEvent | null) => {
    currentMeetingRef.current = meeting
    setCurrentMeetingState(meeting)
  }, [])
  /** BUG-226 is what makes this safe to use at all: the match now collapses
   *  provider mirrors of one meeting, ranks on the hand-made contact link, and
   *  returns NOTHING when it cannot tell two meetings apart. Before that it was
   *  "the first event covering now", and a guessed client injected into a cue is
   *  worse than no client — a cue arrives as advice with nothing on it to check. */
  const getMeetingContactId = useCallback(() => currentMeetingRef.current?.contactId ?? null, [])

  const cueSettings = useCueSettings()
  const cues = useLiveCues(
    transcription.status === 'listening',
    cueSettings.enabled,
    transcription.getCallId,
    cueSettings.sensitivity,
    transcription.otherPartyLive ? 0 : null,
    transcription.identifyRep,
    getMeetingContactId
  )

  const dealIntelligenceSettings = useDealIntelligenceSettings()
  const dealIntelligence = useDealIntelligence(
    transcription.segments,
    transcription.status === 'listening',
    dealIntelligenceSettings.enabled,
    transcription.getCallId,
    dealIntelligenceSettings.sensitivity,
    [],
    currentMeeting,
    dealIntelligenceSettings.enabledTypes,
    dealIntelligenceSettings.frequency
  )

  const value: LiveCallContextValue = {
    ...transcription,
    consent,
    buyerIdentityRef,
    setOnSaved,
    cueSettings,
    cues,
    dealIntelligenceSettings,
    dealIntelligence,
    setCurrentMeeting
  }

  return <LiveCallContext.Provider value={value}>{children}</LiveCallContext.Provider>
}
