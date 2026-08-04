// Monologue meter + passive talk-ratio gauge (§4.2).
//
// The research disagrees with itself about this one, and the disagreement is
// the design constraint. Talk ratio is the single most-loved Gong metric — and
// as a LIVE INTERRUPT it has the weakest evidence of any real-time feature:
// actionable, and distracting exactly when the rep can least afford it. The
// form that survives contact with a real call is a passive meter.
//
// So nothing here interrupts, ever. The meter changes colour and the number
// moves; that is the entire interaction. A rep who is talking too much
// discovers it by glancing, not by being told mid-sentence — which is itself
// an interruption of the thing being measured.
//
// Deterministic throughout: word counts and timestamps from the turn buffer
// that already exists. No ASR beyond what is already running, no model call,
// no network. It keeps working offline and it cannot be wrong in an
// interesting way.

export interface Turn {
  speaker: number
  text: string
  /** Monotonic-ish ms when the turn was last appended to. */
  t: number
}

export const MONOLOGUE_TUNING = {
  /** Uninterrupted rep speech past this reads as a monologue. The spec's
   *  60–90s range; 75s sits in the middle rather than at either edge. */
  nudgeMs: 75_000,
  /** Amber before red, so the meter is a slope rather than a cliff. */
  warnMs: 45_000,
  /** Rep share above this is lopsided. Below it, no opinion is offered —
   *  a discovery call SHOULD be buyer-heavy, and a meter that complains
   *  about listening would be worse than none. */
  highTalkRatio: 0.65,
  /** Fewer words than this and any ratio is noise. */
  minWordsForRatio: 40
} as const

export type MeterTone = 'neutral' | 'good' | 'warn' | 'high'

export interface TalkRatio {
  repWords: number
  otherWords: number
  /** Rep share of words, 0–1. Null until there is enough to say anything. */
  ratio: number | null
  tone: MeterTone
}

function countWords(text: string): number {
  const m = text.trim().match(/\S+/g)
  return m ? m.length : 0
}

/**
 * Rep share of the conversation, by word count.
 *
 * Null — not zero, not 0.5 — until there are enough words to mean something.
 * A gauge that reads "100% you" because the rep said hello first is a gauge
 * the rep stops believing by minute two.
 */
export function computeTalkRatio(turns: Turn[], repSpeaker: number | null): TalkRatio {
  let repWords = 0
  let otherWords = 0
  for (const turn of turns) {
    const words = countWords(turn.text)
    if (repSpeaker !== null && turn.speaker === repSpeaker) repWords += words
    else otherWords += words
  }
  const total = repWords + otherWords
  if (repSpeaker === null || total < MONOLOGUE_TUNING.minWordsForRatio) {
    return { repWords, otherWords, ratio: null, tone: 'neutral' }
  }
  const ratio = repWords / total
  return {
    repWords,
    otherWords,
    ratio,
    // Only one direction is flagged. A discovery call should be buyer-heavy,
    // so "you are listening a lot" is not a problem to report.
    tone: ratio > MONOLOGUE_TUNING.highTalkRatio ? 'high' : 'good'
  }
}

export interface MonologueState {
  /** How long the rep has been talking without the other side getting in. */
  ms: number
  tone: MeterTone
  /** True once past the nudge threshold — drives the meter's colour, never a modal. */
  nudging: boolean
}

/**
 * Tracks the current run of uninterrupted rep speech.
 *
 * "Uninterrupted" is measured by TURNS, not by silence: a pause for breath is
 * not the buyer speaking, and treating it as one would reset the timer every
 * few seconds and never register the monologue it exists to catch. Any turn
 * from anyone else resets it — that is the buyer getting in, which is the
 * thing the rep needs to have happen.
 */
export class MonologueTracker {
  private startedAtMs: number | null = null
  private lastMs = 0

  /**
   * Feed the turn buffer. `repSpeaker` may be null early in a call, before the
   * rep is identified — in which case no monologue can be attributed to them
   * and the tracker deliberately says nothing.
   */
  update(turns: Turn[], repSpeaker: number | null, nowMs: number): MonologueState {
    if (repSpeaker === null || turns.length === 0) {
      this.startedAtMs = null
      this.lastMs = 0
      return { ms: 0, tone: 'neutral', nudging: false }
    }

    // Walk back to the most recent turn that was NOT the rep. Everything after
    // it is the current run.
    let runStart: number | null = null
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].speaker !== repSpeaker) break
      runStart = turns[i].t
    }

    if (runStart === null) {
      // The most recent turn is somebody else's: the buyer is in, run over.
      this.startedAtMs = null
      this.lastMs = 0
      return { ms: 0, tone: 'neutral', nudging: false }
    }

    this.startedAtMs = runStart
    this.lastMs = Math.max(0, nowMs - runStart)
    return {
      ms: this.lastMs,
      tone:
        this.lastMs >= MONOLOGUE_TUNING.nudgeMs
          ? 'high'
          : this.lastMs >= MONOLOGUE_TUNING.warnMs
            ? 'warn'
            : 'good',
      nudging: this.lastMs >= MONOLOGUE_TUNING.nudgeMs
    }
  }

  reset(): void {
    this.startedAtMs = null
    this.lastMs = 0
  }

  get runStartedAt(): number | null {
    return this.startedAtMs
  }
}

/** `1:15`, for a meter read at a glance. */
export function formatMonologue(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
