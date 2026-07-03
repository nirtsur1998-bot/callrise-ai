import { useCallback, useEffect, useRef, useState } from 'react'

// Live in-call coaching cues. The substance comes from a conversation-aware
// Claude call (window.api.transcription.liveCue) over a SPEAKER-LABELED
// transcript window: it identifies the rep and returns one short, grounded cue
// about what the client just said. The only deterministic cue is a rep-only
// "slow down" (so it can never fire on the client).

export type CueKind = 'pace' | 'objection' | 'discovery' | 'next-question' | 'buying-signal'
export type Sensitivity = 'low' | 'medium' | 'high'

export interface LiveCue {
  id: number
  kind: CueKind
  text: string
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

interface Turn {
  speaker: number
  text: string
  t: number
}

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g)
  return m ? m.length : 0
}

export interface UseLiveCues {
  cue: LiveCue | null
  dismiss: () => void
}

/**
 * @param active   true while the call is actually listening (not idle/paused)
 * @param enabled  the user's on/off (mute) toggle
 */
export function useLiveCues(
  active: boolean,
  enabled: boolean,
  sensitivity: Sensitivity
): UseLiveCues {
  const [cue, setCue] = useState<LiveCue | null>(null)

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
  const lastCallAtRef = useRef(0) // last brain call
  const inFlightRef = useRef(false) // single-flight: only one brain call at a time
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
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
      turnsRef.current = []
      lastSpeakerRef.current = null
      repSpeakerRef.current = null
      lastCueAtRef.current = 0
      lastCallAtRef.current = 0
      inFlightRef.current = false
      if (debounceRef.current) clearTimeout(debounceRef.current)
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear a visible cue when cues mute / the call stops
      clearCue()
      return
    }

    // Fresh start for this listening session.
    turnsRef.current = []
    lastSpeakerRef.current = null
    repSpeakerRef.current = null
    inFlightRef.current = false
    lastCallAtRef.current = 0

    const emit = (kind: CueKind, text: string): boolean => {
      const now = Date.now()
      if (cueRef.current) return false // one cue at a time
      if (now - lastCueAtRef.current < cfgRef.current.cooldownMs) return false // hard cooldown
      lastCueAtRef.current = now
      const next: LiveCue = { id: ++idRef.current, kind, text }
      cueRef.current = next
      setCue(next)
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = setTimeout(() => {
        if (mountedRef.current) clearCue()
      }, AUTO_DISMISS_MS)
      return true
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
      if (cueRef.current) return // a cue is already showing
      const repKnown = repSpeakerRef.current !== null
      if (repKnown && now - lastCueAtRef.current < cfgRef.current.cooldownMs) return
      const transcript = windowText()
      if (transcript.length < MIN_CHARS) return

      lastCallAtRef.current = now
      inFlightRef.current = true
      const startedAt = now
      console.log(`[live-cue] → request (${turnsRef.current.length} turns buffered)`)
      void window.api.transcription
        .liveCue(transcript, repSpeakerRef.current)
        .then((res) => {
          if (!mountedRef.current || !res.ok) return
          if (repSpeakerRef.current === null && res.repSpeaker !== null) {
            repSpeakerRef.current = res.repSpeaker // lock the rep for the call
          }
          if (res.cue !== 'none' && res.text) emit(res.cue, res.text)
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
      const rep = repSpeakerRef.current
      if (rep !== null && lastSpeakerRef.current === rep) {
        // The rep just finished — the only deterministic cue, on the rep alone.
        if (repWpm(now) > cfgRef.current.paceWpm) emit('pace', 'Slow down a touch')
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

      if (payload.speechFinal) onTurnEnd(now)
    })

    const offUtteranceEnd = window.api.transcription.onUtteranceEnd(() => onTurnEnd(Date.now()))

    return () => {
      offTranscript()
      offUtteranceEnd()
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [active, enabled, clearCue])

  return { cue, dismiss: clearCue }
}
