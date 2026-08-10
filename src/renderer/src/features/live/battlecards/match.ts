// Deterministic battlecard triggers (§4.4).
//
// This is the FAST tier. No model, no network: a phrase match against the
// rolling partial transcript, which lands in roughly 400ms end to end (ASR
// partial ~300ms + match ~50ms + render ~50ms). That speed is the entire
// reason it exists — by the time a model has read the same sentence, the
// moment to answer the objection has usually gone.
//
// The hard problem here is not matching. It is matching against a buffer that
// keeps being handed to you WITH THE SAME WORDS IN IT. Interim results grow a
// sentence a word at a time, and finalized turns sit in the window for many
// seconds afterwards, so a naive matcher re-fires the same card dozens of
// times for one utterance. Two mechanisms prevent that: a per-trigger cooldown,
// and normalization so that "It's too expensive!" and "its too expensive"
// are recognised as the same phrase rather than as two different ones.

export type BattlecardCategory = 'objection' | 'competitor' | 'pricing' | 'process'

export interface Battlecard {
  id: string
  /** What the buyer said, in the rep's language — the chip's heading. */
  label: string
  /** The one-line response. Short enough to read mid-call, or it is useless. */
  say: string
  category: BattlecardCategory
}

export interface Trigger {
  id: string
  /** Phrases that fire this card. Matched case- and punctuation-insensitively. */
  patterns: string[]
  card: Battlecard
  /** Overrides the default per-trigger cooldown. */
  cooldownMs?: number
}

/** One card per trigger per minute. Long enough that a buyer circling back to
 *  the same objection does not paper the screen, short enough that genuinely
 *  raising it again later still helps. */
export const DEFAULT_COOLDOWN_MS = 60_000

/**
 * Lowercase, fold punctuation, collapse whitespace, and pad with spaces.
 *
 * Apostrophes are DELETED while other punctuation becomes a space, and the
 * difference matters more than it looks. Spacing an apostrophe turns "you're"
 * into "you re", which matches neither "you are" nor "youre" — so a card
 * written for a contraction could never fire on the contraction. Deleting it
 * gives "youre", which is exactly what such a pattern is written as. Other
 * punctuation genuinely separates words ("expensive,really") and must not
 * glue them together.
 *
 * The padding is what makes a naive `includes()` behave like a word-boundary
 * match: searching for `" arm "` inside `" we need an alarm "` fails, where an
 * unpadded `includes('arm')` would happily match the middle of "alarm" and
 * fire a card about contract terms at someone discussing sirens.
 */
export function normalize(text: string): string {
  const folded = text
    .toLowerCase()
    .replace(/['’ʼ]/g, '') // contractions join: you're → youre
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // everything else separates
    .replace(/\s+/g, ' ')
    .trim()
  return ` ${folded} `
}

export class BattlecardMatcher {
  private readonly triggers: Trigger[]
  private readonly defaultCooldownMs: number
  /** Trigger id → when it last fired. */
  private firedAt = new Map<string, number>()

  constructor(triggers: Trigger[], defaultCooldownMs: number = DEFAULT_COOLDOWN_MS) {
    this.triggers = triggers
    this.defaultCooldownMs = defaultCooldownMs
  }

  /**
   * Match the current transcript window. Returns only cards that fire NOW —
   * a trigger still inside its cooldown returns nothing, however many times
   * its phrase appears in the buffer.
   */
  match(text: string, atMs: number): Battlecard[] {
    if (!text) return []
    const haystack = normalize(text)
    const fired: Battlecard[] = []
    for (const trigger of this.triggers) {
      const last = this.firedAt.get(trigger.id)
      const cooldown = trigger.cooldownMs ?? this.defaultCooldownMs
      if (last !== undefined && atMs - last < cooldown) continue
      if (!trigger.patterns.some((p) => haystack.includes(normalize(p)))) continue
      this.firedAt.set(trigger.id, atMs)
      fired.push(trigger.card)
    }
    return fired
  }

  /** A new call: every trigger is eligible again. */
  reset(): void {
    this.firedAt.clear()
  }
}
