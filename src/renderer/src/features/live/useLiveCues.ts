import { useCallback, useEffect, useRef, useState } from 'react'
import { CueLatencyTracker, type CueLatencyReport } from './cue-latency'

// Live in-call coaching cues. The substance comes from a conversation-aware
// Claude call (window.api.transcription.liveCue) over a SPEAKER-LABELED
// transcript window: it identifies the rep and returns one short, grounded cue
// about what the client just said. The only deterministic cue is a rep-only
// "slow down" (so it can never fire on the client).

export type CueKind = 'pace' | 'objection' | 'discovery' | 'next-question' | 'buying-signal'
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
export type { CueTier } from './cue-latency'

export interface LiveCue {
  id: number
  kind: CueKind
  text: string
  /** Monotonic ms when this cue was rendered — used for the side rail's age. */
  at: number
}

/** The one deterministic cue we generate today. Everything else comes from the
 *  model and therefore cannot interrupt. */
const DETERMINISTIC_KINDS: ReadonlySet<CueKind> = new Set<CueKind>(['pace'])

export function tierFor(kind: CueKind): 'interrupt' | 'suggestion' {
  return DETERMINISTIC_KINDS.has(kind) ? 'interrupt' : 'suggestion'
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
const CALL_GAP_MS = 2_500 // minimum gap between brain (LLM) calls
const DEBOUNCE_MS = 400 // wait after a client turn-end before calling the brain
const AUTO_DISMISS_MS = 10_000 // a cue fades on its own if not dismissed
const MIN_CHARS = 30 // not enough transcript to coach on yet
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

interface Turn {
  speaker: number
  text: string
  t: number
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
function computeEngagementScore(turns: Turn[], repSpeaker: number | null): number | null {
  if (turns.length < MIN_TURNS_FOR_ENGAGEMENT) return null

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
    if (repSpeaker !== null && wordsBySpeaker.has(repSpeaker)) {
      dominantShare = (wordsBySpeaker.get(repSpeaker) ?? 0) / totalWords
    } else {
      dominantShare = Math.max(...wordsBySpeaker.values()) / totalWords
    }
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
  sensitivity: Sensitivity,
  knownRepSpeaker: number | null = null
): UseLiveCues {
  const [cue, setCue] = useState<LiveCue | null>(null)
  const [suggestions, setSuggestions] = useState<LiveCue[]>([])
  const [latency, setLatency] = useState<CueLatencyReport>(() => new CueLatencyTracker().report())
  const [repSpeaker, setRepSpeaker] = useState<number | null>(knownRepSpeaker)
  const [engagementScore, setEngagementScore] = useState<number | null>(null)

  const cfgRef = useRef<Thresholds>(SENSITIVITY_THRESHOLDS[sensitivity])
  useEffect(() => {
    cfgRef.current = SENSITIVITY_THRESHOLDS[sensitivity]
  }, [sensitivity])

  const cueRef = useRef<LiveCue | null>(null)
  const idRef = useRef(0)
  const lastCueAtRef = useRef(0)
  const turnsRef = useRef<Turn[]>([]) // recent speaker-labeled turns
  const lastSpeakerRef = useRef<number | null>(null)
  const repSpeakerRef = useRef<number | null>(null) // locked once identified
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
  // When the turn that a cue is answering ended — the clock §1.7 measures from.
  const lastTurnEndAtRef = useRef<number | null>(null)

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
    if (!active || !enabled) {
      generationRef.current++
      turnsRef.current = []
      lastSpeakerRef.current = null
      repSpeakerRef.current = knownRepRef.current
      lastCueAtRef.current = 0
      lastCallAtRef.current = 0
      inFlightRef.current = false
      if (debounceRef.current) clearTimeout(debounceRef.current)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear a visible cue when cues mute / the call stops
      clearCue()
      setSuggestions([])
      latencyRef.current.reset()
      setLatency(latencyRef.current.report())
      lastTurnEndAtRef.current = null
      setRepSpeaker(knownRepRef.current)
      setEngagementScore(null)
      return
    }

    // Fresh start for this listening session.
    generationRef.current++
    turnsRef.current = []
    lastSpeakerRef.current = null
    repSpeakerRef.current = knownRepRef.current
    inFlightRef.current = false
    lastCallAtRef.current = 0
    lastTurnEndAtRef.current = null
    setRepSpeaker(knownRepRef.current)
    setEngagementScore(null)

    // Record turn-end → rendered for whichever tier just delivered (§1.7).
    const noteLatency = (tier: 'interrupt' | 'suggestion'): void => {
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
      noteLatency('interrupt')
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
    const pushSuggestion = (kind: CueKind, text: string): void => {
      const at = performance.now()
      const next: LiveCue = { id: ++idRef.current, kind, text, at }
      setSuggestions((prev) =>
        [next, ...prev.filter((s) => at - s.at < SUGGESTION_TTL_MS)].slice(0, MAX_SUGGESTIONS)
      )
      noteLatency('suggestion')
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
        console.log('[live-cue] skip: a request is already in flight')
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
      console.log(`[live-cue] → request (${turnsRef.current.length} turns buffered)`)
      void window.api.transcription
        .liveCue(transcript, repSpeakerRef.current)
        .then((res) => {
          if (!mountedRef.current || generation !== generationRef.current || !res.ok) return
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
              repSpeakerRef.current = res.repSpeaker // lock the rep for the call
              setRepSpeaker(res.repSpeaker)
            }
          }
          // Side rail, always. This is the line §4.3 exists to enforce: a
          // model response arrives 1.5-2.5s after the moment it describes,
          // which is too late to justify taking over the rep's attention.
          if (res.cue !== 'none' && res.text) pushSuggestion(res.cue, res.text)
        })
        .catch(() => {
          /* ignore — try again on the next turn */
        })
        .finally(() => {
          inFlightRef.current = false
          console.log(`[live-cue] ← done in ${Date.now() - startedAt}ms`)
        })
    }

    // A turn often ends with speechFinal AND utteranceEnd close together —
    // debounce so we coalesce them into a single brain call ~400ms later.
    const scheduleBrain = (): void => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => callBrain(Date.now()), DEBOUNCE_MS)
    }

    const onTurnEnd = (now: number): void => {
      // The moment the measurement starts: everything after this is our
      // latency, not the speaker's.
      lastTurnEndAtRef.current = performance.now()
      const rep = repSpeakerRef.current
      if (rep !== null && lastSpeakerRef.current === rep) {
        // The rep just finished — the only deterministic cue, on the rep alone.
        if (repWpm(now) > cfgRef.current.paceWpm) emitInterrupt('pace', 'Slow down a touch')
      } else {
        // The client just finished (or we don't know the rep yet) — coach it.
        scheduleBrain()
      }
    }

    const offTranscript = window.api.transcription.onTranscript((payload) => {
      const now = Date.now()
      if (!payload.isFinal) return

      if (payload.words.length > 0) {
        // Group consecutive words into per-speaker turns.
        for (const w of payload.words) {
          const last = turnsRef.current[turnsRef.current.length - 1]
          if (last && last.speaker === w.speaker && now - last.t < 4000) {
            last.text += ` ${w.text}`
            last.t = now
          } else {
            turnsRef.current.push({ speaker: w.speaker, text: w.text, t: now })
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

      if (payload.speechFinal) onTurnEnd(now)
    })

    const offUtteranceEnd = window.api.transcription.onUtteranceEnd(() => onTurnEnd(Date.now()))

    return () => {
      offTranscript()
      offUtteranceEnd()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [active, enabled, clearCue])

  return {
    cue,
    dismiss: clearCue,
    suggestions,
    dismissSuggestion,
    latency,
    repSpeaker,
    engagementScore
  }
}
