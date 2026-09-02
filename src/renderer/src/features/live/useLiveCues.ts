import { useCallback, useEffect, useRef, useState } from 'react'
import { CueLatencyTracker, type CueLatencyReport } from './cue-latency'
import { BattlecardMatcher, type Battlecard } from './battlecards/match'
import { STARTER_TRIGGERS } from './battlecards/library'
import { otherPartyObservable } from './other-party-capture'
import { MonologueTracker, type MonologueState } from './monologue'
import { speakerKey } from './segments'

// Live in-call coaching cues. The substance comes from a conversation-aware
// Claude call (window.api.transcription.liveCue) over a SPEAKER-LABELED
// transcript window: it identifies the rep and returns one short, grounded cue
// about what the client just said. The only deterministic cue is a rep-only
// "slow down" (so it can never fire on the client).

export type CueKind =
  'pace' | 'battlecard' | 'objection' | 'discovery' | 'next-question' | 'buying-signal'
export type Sensitivity = 'low' | 'medium' | 'high'

/**
 * Which channel a cue is allowed to use — the two-tier split (§4.3).
 *
 * A deterministic trigger lands in roughly 400ms (ASR partial ~300 + match ~50
 * + render ~50). An LLM-generated one realistically lands in 1.5–2.5s, which
 * is past the threshold where an interruption starts costing the rep more
 * attention than it returns. So the slow tier is structurally forbidden from
 * interrupting: it goes to a side rail the rep reads when they choose to.
 *
 * This is enforced by construction rather than by convention — `tierFor`
 * derives the tier from the kind, so there is no code path that can put an
 * LLM cue on the interrupt channel.
 */

export interface LiveCue {
  id: number
  kind: CueKind
  text: string
  /** Monotonic ms when this cue was rendered — used for the side rail's age. */
  at: number
}

/**
 * Which kinds may take over the rep's attention.
 *
 * Note that being deterministic is NECESSARY but not sufficient. A battlecard
 * is produced by phrase match and lands just as fast as the pace cue, yet it
 * belongs in the rail: it is reference material the rep consults, not a nudge
 * about something they are doing wrong right now. Speed earns the right to
 * interrupt; it does not create the reason to.
 */
const INTERRUPT_KINDS: ReadonlySet<CueKind> = new Set<CueKind>(['pace'])

export function tierFor(kind: CueKind): 'interrupt' | 'suggestion' {
  return INTERRUPT_KINDS.has(kind) ? 'interrupt' : 'suggestion'
}

export const SENSITIVITIES: Sensitivity[] = ['low', 'medium', 'high']

interface Thresholds {
  paceWpm: number // rep words/min over the recent window before "slow down"
  cooldownMs: number // minimum gap between any two displayed cues
}

// "low" is the calm default; "high" shows cues more readily. Cooldown tightened
// so a cue surfaces close to the moment, not 10–20s later.
export const SENSITIVITY_THRESHOLDS: Record<Sensitivity, Thresholds> = {
  low: { paceWpm: 200, cooldownMs: 45_000 },
  medium: { paceWpm: 185, cooldownMs: 30_000 },
  high: { paceWpm: 170, cooldownMs: 20_000 }
}

const WINDOW_TURNS = 24 // recent speaker turns sent to the brain (fixed size)
const MAX_TURNS = 80 // cap the in-memory turn buffer
const PACE_WINDOW_MS = 15_000 // window for the rep-only words/min estimate
// M27 H1 — DERIVED, not chosen: matches model-pacing.ts's PACING_GAP_MS,
// which is 60_000 / 10 (Gemini 2.5 Flash's conservative documented free-tier
// floor, 10-15 RPM). `live`-tier purposes (coaching-cue is one) are
// deliberately exempt from that cross-purpose pacing gate for latency — but
// that means THIS is the only thing standing between coaching-cue and
// exceeding a low-RPM provider's own limit, on its own, with zero help from
// any other purpose. The previous value (2_500ms) allowed up to 24
// requests/minute from this purpose alone — 1.6-2.4x over Gemini's floor
// before anything else even contributes, a plausible direct cause of
// "coaching cues temporarily unavailable" mid-call. Same floor, same
// reasoning, applied where the pacing gate can't reach.
const CALL_GAP_MS = 6_000 // minimum gap between brain (LLM) calls
const DEBOUNCE_MS = 400 // wait after a client turn-end before calling the brain
/** How long an interrupt cue stays before fading. Exported because the card's
 *  countdown bar animates against it — two copies of this number drift the
 *  moment either is tuned, and the symptom is a bar that finishes early or
 *  hangs full while the cue vanishes underneath it. */
export const AUTO_DISMISS_MS = 10_000
const MIN_CHARS = 30 // not enough transcript to coach on yet
/** Per-turn tracing. On the hot path — a 40-minute call fires these hundreds
 *  of times — so it is compiled out of a production build rather than
 *  shipping console noise (and the template-literal work behind it) to users. */
const trace: (message: string) => void = import.meta.env.DEV
  ? (message) => console.log(message)
  : () => {}

const MAX_SUGGESTIONS = 3 // side rail depth — a reading list, not a backlog
const SUGGESTION_TTL_MS = 90_000 // advice about a moment that has passed is noise

// --- Engagement gauge (deterministic, no AI call) ---------------------------
// A rough, client-side-only approximation of how "live" the conversation
// feels right now. It is NOT a coaching signal and makes no claim about call
// quality — see the formula comment on computeEngagementScore below.
const ENGAGEMENT_WINDOW = 20 // turns considered for the talk-balance + question signals
const GAP_WINDOW = 10 // most-recent turns considered for the pace signal (recency-weighted)
const GAP_FAST_MS = 8_000 // a new turn arriving this quickly reads as brisk back-and-forth
const GAP_SLOW_MS = 45_000 // a gap this long reads as a one-sided monologue
const GAP_DECAY = 0.85 // per-step recency decay — the most recent gap counts most
const QUESTION_IDEAL_RATIO = 0.3 // ~30%+ of turns being questions reads as fully engaged
const MIN_TURNS_FOR_ENGAGEMENT = 4 // too little signal before this — stay null

export interface Turn {
  speaker: number
  text: string
  t: number
  /** M26 4.5 (BUG-055) — present only for a multichannel/buyer-capture turn
   *  (mirrors TranscriptWord.channel). Precise, per-turn knowledge of
   *  whether THIS turn is genuinely buyer-attributed, the same way
   *  useDealIntelligence.ts's LiveTurn.role already is — not a per-call
   *  guess, since a diarized mono turn is never a genuine "other party"
   *  signal (BUG-002) and must never gate on this. */
  channel?: number
}

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g)
  return m ? m.length : 0
}

/**
 * Blends three deterministic, word-count-level signals from the same turn
 * buffer the brain already uses — no extra AI call, no new data source:
 *
 *  (a) Talk-ratio balance (40%) — the rep shouldn't dominate. When the rep's
 *      speaker id is already known, this scores their literal share of words
 *      in the recent window; 50%/50% or less is full credit, and credit falls
 *      off linearly as one side's share climbs past 50% toward 100%. Before
 *      the rep is identified, it falls back to whichever speaker is more
 *      talkative (a symmetric stand-in — we can't yet tell which side that is).
 *  (b) Question-asking frequency (30%) — either side asking questions reads
 *      as an exploratory conversation rather than a one-way pitch. Scored as
 *      the share of recent turns ending in "?", reaching full credit at a
 *      ~30% question-turn ratio.
 *  (c) Recency-weighted response pace (30%) — the gap between consecutive
 *      turns (a new turn starts on a speaker change or a 4s+ pause within one
 *      speaker). Short gaps read as brisk back-and-forth; long ones read as a
 *      monologue. Averaged with an exponential recency decay so the last
 *      couple of exchanges matter more than older ones.
 *
 * This is a rough proxy for engagement, not sentiment or call quality — it
 * only counts words, question marks, and timestamps already in the buffer.
 */
export function computeEngagementScore(turns: Turn[], repSpeaker: number | null): number | null {
  if (turns.length < MIN_TURNS_FOR_ENGAGEMENT) return null

  // Stage 3a FINDING 1 (HIGH) — talk-balance is 40% of this score and it is the
  // rep's SHARE OF WORDS. On a call whose other side was never captured every
  // word is the rep's, so the share is 100% and balance scores 0. Measured on
  // identical rep audio: 81 two-sided, 57 one-sided. The rep is shown a worse
  // engagement reading because the APP failed to record the buyer.
  //
  // No caveat, no footnote, no number. A number with a caveat gets read as a
  // number — the same reasoning as the outcome-tracking gate.
  if (!otherPartyObservable(turns)) return null

  // Stage 3a FINDING 3 (MEDIUM) — 3b-2. The old fallback, when the rep was not
  // yet identified, scored 'whichever speaker is more talkative', calling it
  // 'a symmetric stand-in'. It is symmetric arithmetically and NOT in meaning:
  // a rep dominating is a pitch and a real problem, a buyer dominating is the
  // rep listening and the goal of a discovery call. Both scored the same, so a
  // buyer-dominant call read 37 (balance 18) at the moment it was going best.
  //
  // MONOLOGUE_TUNING already states the correct principle one file away: 'a
  // discovery call SHOULD be buyer-heavy, and a meter that complains about
  // listening would be worse than none.' Guessing symmetrically is still
  // guessing, so when the rep cannot be identified this declines instead.
  if (repSpeaker === null) return null

  const recent = turns.slice(-ENGAGEMENT_WINDOW)

  const wordsBySpeaker = new Map<number, number>()
  let totalWords = 0
  for (const t of recent) {
    const w = countWords(t.text)
    wordsBySpeaker.set(t.speaker, (wordsBySpeaker.get(t.speaker) ?? 0) + w)
    totalWords += w
  }
  let dominantShare = 0
  if (totalWords > 0) {
    // repSpeaker is non-null past the guard above, and a rep with no words in
    // the window scores a 0 share — which is the buyer-heavy case, and full
    // credit, exactly as intended.
    dominantShare = (wordsBySpeaker.get(repSpeaker) ?? 0) / totalWords
  }
  const balanceScore = Math.max(0, 100 - Math.max(0, dominantShare - 0.5) * 200)

  const questionTurns = recent.filter((t) => t.text.trim().endsWith('?')).length
  const questionScore = Math.min(100, (questionTurns / recent.length / QUESTION_IDEAL_RATIO) * 100)

  const gapTurns = turns.slice(-GAP_WINDOW)
  let gapWeighted = 0
  let gapWeightTotal = 0
  for (let i = 1; i < gapTurns.length; i++) {
    const gap = gapTurns[i].t - gapTurns[i - 1].t
    const gapScoreI =
      gap <= GAP_FAST_MS
        ? 100
        : gap >= GAP_SLOW_MS
          ? 0
          : 100 * (1 - (gap - GAP_FAST_MS) / (GAP_SLOW_MS - GAP_FAST_MS))
    const weight = GAP_DECAY ** (gapTurns.length - 1 - i) // most recent gap → weight 1
    gapWeighted += gapScoreI * weight
    gapWeightTotal += weight
  }
  const paceScore = gapWeightTotal > 0 ? gapWeighted / gapWeightTotal : 50 // not enough gaps yet — neutral

  const blended = 0.4 * balanceScore + 0.3 * questionScore + 0.3 * paceScore
  return Math.round(Math.max(0, Math.min(100, blended)))
}

export interface UseLiveCues {
  /** The INTERRUPT channel: deterministic cues only, one at a time. */
  cue: LiveCue | null
  dismiss: () => void
  /** The side rail: model-generated suggestions, newest first. Never
   *  interrupts, never blocks a deterministic cue, never steals focus. */
  suggestions: LiveCue[]
  dismissSuggestion: (id: number) => void
  /** Measured turn-end → cue-rendered latency, per tier (§1.7). */
  latency: CueLatencyReport
  /** The rep's speaker id once identified (deterministic or brain-guessed), for
   *  labeling the transcript "You"/"Buyer". Null until known. */
  repSpeaker: number | null
  /** Rolling 0–100 approximation of how "live" the conversation feels right
   *  now (see computeEngagementScore) — NOT a coaching or AI-derived score.
   *  Null until at least MIN_TURNS_FOR_ENGAGEMENT turns have been seen. */
  engagementScore: number | null
  /** The current run of uninterrupted rep speech (§4.2) — a passive read,
   *  never an interrupt. Null before the rep is identified. */
  monologue: MonologueState | null
  /** M19 Task 2 step 5 — the buyer's name, once they've explicitly
   *  introduced themselves AND Settings has self-intro extraction on. Null
   *  otherwise. Paired with buyerIdentityKey (speakerKey() format) so the
   *  caller can build a SpeakerIdentities map for live display. */
  buyerName: string | null
  buyerIdentityKey: string | null
  /** M20 — every model in the fallback chain failed the most recent
   *  liveCue() attempt. Non-blocking: transcription is unaffected, this
   *  just means AI cues are temporarily unavailable. Clears itself the
   *  moment a call succeeds again. */
  coachingPaused: boolean
  /** BUG-057 Phase 2 — WHY coachingPaused is true, for copy only. undefined
   *  whenever coachingPaused is false. */
  coachingPausedReason: 'all-models-unavailable' | 'timed-out' | 'quota-exhausted' | undefined
}

/**
 * @param active           true while the call is actually listening
 * @param enabled          the user's on/off (mute) toggle
 * @param sensitivity      cue sensitivity
 * @param knownRepSpeaker  the rep's speaker id when it's known deterministically
 *                         (0 while buyer capture is live via multichannel); null
 *                         falls back to the M9 heuristic that guesses the rep.
 */
export function useLiveCues(
  active: boolean,
  enabled: boolean,
  /** M26 4.5 (BUG-055) — the CALL id, from useTranscription's getCallId().
   *  See useDealIntelligence.ts's identical parameter for the full rationale:
   *  `active` blips false during an ordinary mono<->multichannel restart, and
   *  resetting on that blip (rather than on a genuine new call) is what let a
   *  navigate-away-and-back — or, mid-call, a buyer-capture toggle — silently
   *  wipe the interrupt channel's cooldown/dedupe state. */
  getCallId: () => string | null,
  sensitivity: Sensitivity,
  knownRepSpeaker: number | null = null,
  /** Told to the transcript the moment the rep is identified, so already-
   *  recorded turns in this epoch can be back-filled ONCE instead of the UI
   *  re-deriving attribution from mutable state at render time. */
  onRepIdentified?: (epoch: number, speaker: number) => void
): UseLiveCues {
  const [cue, setCue] = useState<LiveCue | null>(null)
  const [suggestions, setSuggestions] = useState<LiveCue[]>([])
  const [latency, setLatency] = useState<CueLatencyReport>(() => new CueLatencyTracker().report())
  const [repSpeaker, setRepSpeaker] = useState<number | null>(knownRepSpeaker)
  const [engagementScore, setEngagementScore] = useState<number | null>(null)
  const [monologue, setMonologue] = useState<MonologueState | null>(null)
  const [buyerName, setBuyerName] = useState<string | null>(null)
  const [buyerIdentityKey, setBuyerIdentityKey] = useState<string | null>(null)
  // M20 — every configured model in the fallback chain failed this cycle.
  // Non-blocking: transcription keeps running, this just says AI cues are
  // temporarily unavailable. Cleared the moment a call succeeds again.
  const [coachingPaused, setCoachingPaused] = useState(false)
  // BUG-057 Phase 2 — the WHY behind coachingPaused, for copy only. Kept as a
  // separate field rather than folded into the boolean: LiveView's banner
  // text needs to say something true ("taking too long" vs "unreachable or
  // rate-limited"), but nothing else in this hook needs to branch on it —
  // every other consumer only ever needed "is coaching paused right now."
  const [coachingPausedReason, setCoachingPausedReason] = useState<
    'all-models-unavailable' | 'timed-out' | 'quota-exhausted' | undefined
  >(undefined)
  const monologueRef = useRef(new MonologueTracker())

  const cfgRef = useRef<Thresholds>(SENSITIVITY_THRESHOLDS[sensitivity])
  useEffect(() => {
    cfgRef.current = SENSITIVITY_THRESHOLDS[sensitivity]
  }, [sensitivity])

  // M26 4.5 (BUG-055) — see the effect below. Tracks what the last reset
  // decision was based on, so a genuine call boundary can be told apart from
  // `active` merely blipping mid-call.
  const lastCallIdRef = useRef<string | null>(null)
  const wasEnabledRef = useRef(enabled)

  const cueRef = useRef<LiveCue | null>(null)
  const idRef = useRef(0)
  const lastCueAtRef = useRef(0)
  const turnsRef = useRef<Turn[]>([]) // recent speaker-labeled turns
  const lastSpeakerRef = useRef<number | null>(null)
  const repSpeakerRef = useRef<number | null>(null) // locked once identified
  // Speaker-label namespace the buffered turns belong to. Deepgram restarts
  // diarization on every reconnect, so turns either side of one are labelled
  // by different schemes and must never share a rep-lock or a window.
  const epochRef = useRef<number | null>(null)
  const onRepIdentifiedRef = useRef(onRepIdentified)
  useEffect(() => {
    onRepIdentifiedRef.current = onRepIdentified
  }, [onRepIdentified])
  const buyerNameRef = useRef<string | null>(null) // one-shot per call, like repSpeakerRef
  // When buyer capture is live the rep is deterministically channel 0.
  const knownRepRef = useRef<number | null>(knownRepSpeaker)
  const lastCallAtRef = useRef(0) // last brain call
  const inFlightRef = useRef(false) // single-flight: only one brain call at a time
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  // Bumped on every reset/fresh-start so an in-flight brain response from a
  // previous listening session is discarded instead of leaking into this one.
  const generationRef = useRef(0)
  const latencyRef = useRef(new CueLatencyTracker())
  const battlecardsRef = useRef(new BattlecardMatcher(STARTER_TRIGGERS))
  // When the turn that a cue is answering ended — the clock §1.7 measures from.
  const lastTurnEndAtRef = useRef<number | null>(null)

  // Custom trackers (§4.8) load asynchronously from disk, so the matcher
  // starts with just the starter library and is rebuilt once they arrive —
  // always well before any call is live, since this hook mounts with the
  // whole Live Calls screen, not per-call. A brand new instance rather than
  // mutating the existing one: BattlecardMatcher has no "add trigger" method,
  // and adding one just for this would be more surface for one-time startup
  // work that never repeats mid-call.
  useEffect(() => {
    let cancelled = false
    window.api.trackers
      .list()
      .then((custom) => {
        if (cancelled || custom.length === 0) return
        battlecardsRef.current = new BattlecardMatcher([...STARTER_TRIGGERS, ...custom])
      })
      .catch(() => {
        /* starter library alone is still a fully working set */
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  // Buyer capture live → lock the rep to channel 0 and skip the brain's guess.
  // (Can flip on mid-call; the main effect below re-reads knownRepRef on reset.)
  useEffect(() => {
    knownRepRef.current = knownRepSpeaker
    // Buyer capture just stopped (channel-0 certainty lost) — revert to
    // unknown rather than leaving the transcript labeling stuck on the old
    // channel, so the brain's own guess (or "Speaker N") takes back over.
    repSpeakerRef.current = knownRepSpeaker
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirror the ref for the transcript label when buyer capture starts/stops mid-call
    setRepSpeaker(knownRepSpeaker)

    // A self-intro resolved BEFORE buyer capture went live was necessarily
    // keyed to a mono speaker number (the only regime that existed then) —
    // see the one-shot resolution below. Once multichannel is now active,
    // the buyer is unambiguously channel 1 (a fixed loopback/hardware fact,
    // never a guess), so recompute the key to match. Without this, the
    // already-resolved name stays stuck under the stale mono key: new
    // segments recorded after the switch (now channel-tagged) never match
    // it for live display, and resolve.ts's own current-regime filter
    // ignores the stale-regime key entirely at save time. The reverse
    // transition (multichannel -> mono) is deliberately left alone — mono
    // has no fixed buyer index to recompute onto, so the name is kept as-is
    // rather than guessed at.
    if (knownRepSpeaker === 0 && buyerNameRef.current !== null) {
      setBuyerIdentityKey(speakerKey({ speaker: 1, channel: 1 }))
    }
  }, [knownRepSpeaker])

  const dismissSuggestion = useCallback((id: number) => {
    setSuggestions((prev) => prev.filter((s) => s.id !== id))
  }, [])

  const clearCue = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
    cueRef.current = null
    setCue(null)
  }, [])

  useEffect(() => {
    // M26 4.5 (BUG-055) — `active` (`status === 'listening'`) is not a proxy
    // for "the call ended." It also blips false during an ordinary
    // mono<->multichannel restart mid-call (main emits `state:'connecting'`
    // for that too), and — before this hook was hoisted into
    // LiveCallProvider — on every screen navigation, since the whole hook
    // instance was torn down and rebuilt. Wiping the interrupt channel's
    // one-slot gate and cooldown clock (cueRef/lastCueAtRef) on that blip is
    // exactly what let an already-suppressed cue fire again the moment the
    // blip passed. Only a genuinely NEW call (a different callId than last
    // observed) or the rep explicitly disabling the feature may wipe this
    // state; `active` itself only decides whether to (re)subscribe below.
    const currentCallId = getCallId()
    const isGenuineNewCall =
      currentCallId !== null &&
      lastCallIdRef.current !== null &&
      currentCallId !== lastCallIdRef.current
    const justDisabled = wasEnabledRef.current && !enabled
    lastCallIdRef.current = currentCallId
    wasEnabledRef.current = enabled
    const shouldReset = isGenuineNewCall || justDisabled

    if (!active || !enabled) {
      if (!shouldReset) return
      generationRef.current++
      turnsRef.current = []
      lastSpeakerRef.current = null
      repSpeakerRef.current = knownRepRef.current
      lastCueAtRef.current = 0
      lastCallAtRef.current = 0
      inFlightRef.current = false
      if (debounceRef.current) clearTimeout(debounceRef.current)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear a visible cue when cues mute / the call ends, but only on a genuine call boundary — see the comment above
      clearCue()
      setSuggestions([])
      latencyRef.current.reset()
      battlecardsRef.current.reset()
      setLatency(latencyRef.current.report())
      lastTurnEndAtRef.current = null
      setRepSpeaker(knownRepRef.current)
      setEngagementScore(null)
      monologueRef.current.reset()
      setMonologue(null)
      buyerNameRef.current = null
      setBuyerName(null)
      setBuyerIdentityKey(null)
      return
    }

    // Fresh start for this listening session — but ONLY on a genuine call
    // boundary (see the comment above the effect). Reaching this point with
    // `shouldReset` false means `active` just came back from an ordinary
    // blip (a restart) on the SAME call: turnsRef, the rep lock, and
    // everything else this block would otherwise wipe are exactly what
    // should survive it. Subscriptions below still re-wire either way — that
    // part was never the bug.
    if (shouldReset) {
      generationRef.current++
      turnsRef.current = []
      lastSpeakerRef.current = null
      repSpeakerRef.current = knownRepRef.current
      inFlightRef.current = false
      lastCallAtRef.current = 0
      lastTurnEndAtRef.current = null
      battlecardsRef.current.reset()
      setRepSpeaker(knownRepRef.current)
      setEngagementScore(null)
      monologueRef.current.reset()
      setMonologue(null)
    }

    // Record turn-end → rendered for whichever tier just delivered (§1.7).
    const noteLatency = (tier: 'deterministic' | 'model'): void => {
      const startedAt = lastTurnEndAtRef.current
      if (startedAt === null) return
      latencyRef.current.record(tier, performance.now() - startedAt)
      setLatency(latencyRef.current.report())
    }

    // THE INTERRUPT CHANNEL — deterministic cues only.
    //
    // Keeps the strict one-at-a-time slot and the cooldown, because an
    // interruption mid-sentence is expensive and has to earn its place. Only
    // reachable for kinds `tierFor` classifies as deterministic; there is no
    // path from a model response to here.
    const emitInterrupt = (kind: CueKind, text: string): boolean => {
      if (tierFor(kind) !== 'interrupt') return false // unreachable by construction
      const now = Date.now()
      if (cueRef.current) return false // one cue at a time
      if (now - lastCueAtRef.current < cfgRef.current.cooldownMs) return false // hard cooldown
      lastCueAtRef.current = now
      const next: LiveCue = { id: ++idRef.current, kind, text, at: performance.now() }
      cueRef.current = next
      setCue(next)
      noteLatency('deterministic')
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = setTimeout(() => {
        if (mountedRef.current) clearCue()
      }, AUTO_DISMISS_MS)
      return true
    }

    // THE SIDE RAIL — model-generated suggestions.
    //
    // Deliberately none of the interrupt channel's machinery: no single slot,
    // no cooldown, no auto-dismiss timer stealing it away mid-read, and no
    // check against whether a deterministic cue is showing. A suggestion
    // arriving cannot delay, replace or suppress an interrupt, and an
    // interrupt showing cannot suppress a suggestion — that independence IS
    // the two-tier architecture.
    //
    // Bounded and aged instead: three at most, newest first, and anything
    // older than the TTL is dropped on the way in, because advice about a
    // moment that has already passed is noise wearing the clothes of help.
    const pushSuggestion = (
      kind: CueKind,
      text: string,
      source: 'deterministic' | 'model'
    ): void => {
      const at = performance.now()
      const next: LiveCue = { id: ++idRef.current, kind, text, at }
      setSuggestions((prev) =>
        [next, ...prev.filter((s) => at - s.at < SUGGESTION_TTL_MS)].slice(0, MAX_SUGGESTIONS)
      )
      noteLatency(source)
    }

    // A battlecard is deterministic and therefore fast, but it is reference
    // material rather than a nudge — so it takes the rail, not the interrupt.
    const pushBattlecard = (card: Battlecard): void => {
      pushSuggestion('battlecard', `${card.label} — ${card.say}`, 'deterministic')
    }

    const windowText = (): string => {
      return turnsRef.current
        .slice(-WINDOW_TURNS)
        .map((t) => `Speaker ${t.speaker}: ${t.text}`)
        .join('\n')
    }

    const repWpm = (now: number): number => {
      const rep = repSpeakerRef.current
      if (rep === null) return 0
      const cutoff = now - PACE_WINDOW_MS
      let words = 0
      for (const t of turnsRef.current) {
        if (t.speaker === rep && t.t >= cutoff) words += countWords(t.text)
      }
      return Math.round(words / (PACE_WINDOW_MS / 60_000))
    }

    // Ask the brain for a contextual cue (non-blocking). Only call when we could
    // actually show one — so API calls track display opportunities, not chatter.
    const callBrain = (now: number): void => {
      if (inFlightRef.current) {
        trace('[live-cue] skip: a request is already in flight')
        return
      }
      if (now - lastCallAtRef.current < CALL_GAP_MS) return
      // Deliberately NOT gated on a visible interrupt or on the interrupt
      // cooldown any more. Those guards belong to the interrupt channel;
      // applying them here made a deterministic "slow down" silently suppress
      // the side rail for the whole cooldown, which re-couples the two tiers
      // the split exists to separate.
      const transcript = windowText()
      if (transcript.length < MIN_CHARS) return

      lastCallAtRef.current = now
      inFlightRef.current = true
      const startedAt = now
      const generation = generationRef.current // discard the response if the session resets
      trace(`[live-cue] → request (${turnsRef.current.length} turns buffered)`)
      // M26 4.5 (BUG-055) — precise, per-turn check over the SAME window
      // windowText() just built: a channel-tagged turn that isn't the rep's
      // own channel is genuine buyer-attributed content (never a diarized
      // mono guess — see Turn.channel's own doc comment). Main re-checks
      // consent fresh before including any of it in a prompt.
      const includesBuyerContent = turnsRef.current
        .slice(-WINDOW_TURNS)
        .some((t) => t.channel !== undefined && t.channel !== knownRepRef.current)
      void window.api.transcription
        .liveCue(transcript, repSpeakerRef.current, getCallId() ?? undefined, includesBuyerContent)
        .then((res) => {
          if (!mountedRef.current || generation !== generationRef.current) return
          if (!res.ok) {
            // BUG-057 Phase 2 — any pausedReason means paused, full stop.
            // The old strict-equality check silently read a 'timed-out'
            // result as NOT paused (since it only ever matched the single
            // literal 'all-models-unavailable') — this is the exact bug
            // that made a real, ongoing failure invisible to the rep.
            setCoachingPaused(res.pausedReason !== undefined)
            setCoachingPausedReason(res.pausedReason)
            return
          }
          setCoachingPaused(false)
          setCoachingPausedReason(undefined)
          if (repSpeakerRef.current === null && res.repSpeaker !== null) {
            // Same guard as coach.ts's batch path (speakers.has(repSpeaker)):
            // never lock onto a speaker id that hasn't actually appeared in
            // this call. Without it, a hallucinated/nonexistent guess gets
            // locked in for the rest of the call — the rep-only pace
            // safeguard then never fires (it compares against the wrong id),
            // and every cue meant for the client fires on the rep's own
            // words instead.
            const observedSpeakers = new Set(turnsRef.current.map((t) => t.speaker))
            if (observedSpeakers.has(res.repSpeaker)) {
              repSpeakerRef.current = res.repSpeaker // lock the rep for the epoch
              setRepSpeaker(res.repSpeaker)
              // Back-fill the turns already on screen, once, in this epoch only.
              if (epochRef.current !== null) {
                onRepIdentifiedRef.current?.(epochRef.current, res.repSpeaker)
              }
            }
          }
          // One-shot: once resolved, keep it — a later window with no
          // self-intro in view must not un-name someone who already said it.
          if (buyerNameRef.current === null && res.buyerName && res.buyerSpeaker !== null) {
            // knownRepRef.current === 0 signals multichannel-active (see the
            // hook's own JSDoc above) — in that mode speaker IS the channel.
            const channel = knownRepRef.current === 0 ? res.buyerSpeaker : undefined
            const key = speakerKey({ speaker: res.buyerSpeaker, channel })
            buyerNameRef.current = res.buyerName
            setBuyerName(res.buyerName)
            setBuyerIdentityKey(key)
          }
          // Side rail, always. This is the line §4.3 exists to enforce: a
          // model response arrives 1.5-2.5s after the moment it describes,
          // which is too late to justify taking over the rep's attention.
          if (res.cue !== 'none' && res.text) pushSuggestion(res.cue, res.text, 'model')
        })
        .catch(() => {
          /* ignore — try again on the next turn */
        })
        .finally(() => {
          inFlightRef.current = false
          trace(`[live-cue] ← done in ${Date.now() - startedAt}ms`)
        })
    }

    // A turn often ends with speechFinal AND utteranceEnd close together —
    // debounce so we coalesce them into a single brain call ~400ms later.
    const scheduleBrain = (): void => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => callBrain(Date.now()), DEBOUNCE_MS)
    }

    // `endedSpeaker` is passed explicitly rather than read from mutable shared
    // state. utteranceEnd arrives as a SEPARATE event ~1s after speech stops,
    // and any transcript landing in that window overwrites lastSpeakerRef
    // first — so the branch below was routinely decided against the wrong
    // speaker, firing the rep-only pace cue on the client.
    const onTurnEnd = (now: number, endedSpeaker: number | null): void => {
      // The moment the measurement starts: everything after this is our
      // latency, not the speaker's.
      lastTurnEndAtRef.current = performance.now()
      const rep = repSpeakerRef.current
      if (rep !== null && endedSpeaker === rep) {
        // The rep just finished — the only deterministic cue, on the rep alone.
        if (repWpm(now) > cfgRef.current.paceWpm) emitInterrupt('pace', 'Slow down a touch')
      } else {
        // The client just finished (or we don't know the rep yet) — coach it.
        scheduleBrain()
      }
    }

    const offTranscript = window.api.transcription.onTranscript((payload) => {
      const now = Date.now()

      // Battlecards match the ROLLING PARTIAL buffer, before the isFinal gate
      // below. That is the whole ~400ms budget: waiting for a finalized turn
      // would add a second or more, by which point the moment to answer the
      // objection has usually gone.
      //
      // Skipped while the REP is the one talking — a rep restating an
      // objection back to the buyer should not fire a card at themselves. The
      // clock also starts here rather than at turn-end, because this cue is
      // answering the words as they arrive, not the turn.
      const partial = payload.transcript.trim()
      if (partial) {
        const rep = repSpeakerRef.current
        const lastSpeaker = payload.words[payload.words.length - 1]?.speaker ?? null
        if (rep === null || lastSpeaker !== rep) {
          const cards = battlecardsRef.current.match(partial, now)
          if (cards.length > 0) {
            lastTurnEndAtRef.current = performance.now()
            for (const card of cards) pushBattlecard(card)
          }
        }
      }

      if (!payload.isFinal) return

      // A new speaker-label namespace (reconnect, or the mono↔multichannel
      // swap) invalidates everything buffered: the ids no longer refer to the
      // same people. Carrying the old rep-lock or window across was what made
      // post-reconnect cues name the wrong person.
      if (epochRef.current !== payload.speakerEpoch) {
        epochRef.current = payload.speakerEpoch
        turnsRef.current = []
        lastSpeakerRef.current = null
        // Multichannel attribution is deterministic (channel 0 is the rep), so
        // it survives; a diarization guess does not and must be re-earned.
        repSpeakerRef.current = payload.multichannel ? 0 : knownRepRef.current
        setRepSpeaker(repSpeakerRef.current)
        // Discard any brain response still in flight from the old namespace.
        generationRef.current += 1
      }

      if (payload.words.length > 0) {
        // Group consecutive words into per-speaker turns.
        for (const w of payload.words) {
          const last = turnsRef.current[turnsRef.current.length - 1]
          if (last && last.speaker === w.speaker && now - last.t < 4000) {
            last.text += ` ${w.text}`
            last.t = now
          } else {
            turnsRef.current.push({ speaker: w.speaker, text: w.text, t: now, channel: w.channel })
          }
        }
        lastSpeakerRef.current = payload.words[payload.words.length - 1].speaker
      } else if (payload.transcript.trim()) {
        const speaker = lastSpeakerRef.current ?? 0
        turnsRef.current.push({ speaker, text: payload.transcript.trim(), t: now })
      }
      if (turnsRef.current.length > MAX_TURNS) {
        turnsRef.current = turnsRef.current.slice(-MAX_TURNS)
      }

      // Recompute the deterministic engagement gauge on every finalized turn
      // update — cheap (word-counting over ≤24 turns), no brain/AI call.
      setEngagementScore(computeEngagementScore(turnsRef.current, repSpeakerRef.current))
      // Same pass updates the monologue meter (§4.2) — a passive read of the
      // rep's current uninterrupted-speech run, never an interrupt.
      setMonologue(monologueRef.current.update(turnsRef.current, repSpeakerRef.current, now))

      if (payload.speechFinal) onTurnEnd(now, lastSpeakerRef.current)
    })

    // Attribute to the turn that actually ended, not to whatever has since
    // arrived (see onTurnEnd).
    const offUtteranceEnd = window.api.transcription.onUtteranceEnd(() =>
      onTurnEnd(Date.now(), turnsRef.current[turnsRef.current.length - 1]?.speaker ?? null)
    )

    return () => {
      offTranscript()
      offUtteranceEnd()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [active, enabled, clearCue, getCallId])

  return {
    cue,
    dismiss: clearCue,
    suggestions,
    dismissSuggestion,
    latency,
    repSpeaker,
    engagementScore,
    monologue,
    buyerName,
    buyerIdentityKey,
    coachingPaused,
    coachingPausedReason
  }
}
