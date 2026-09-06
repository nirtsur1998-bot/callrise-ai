/**
 * M36 Stage 2 — the glance HUD, the pure parts.
 *
 * The thesis (docs/M36-hud-proposal.md, argued with and amended by the
 * founder 2026-09-06): the HUD is a single line, not a dashboard. Three
 * zones — the glance line, the state strip (with the deal facts folded in),
 * the transcript demoted but on by default and collapsible. Every cue
 * carries the evidence it was made from, or it does not render. Cues are
 * delivered in the rep's lull, never over their own sentence. And the
 * absorption instrument — how many shown cues a rep marks useful, per kind —
 * is built with it, because nobody has published that number.
 *
 * This file has no React and no DOM: the layout preference, the evidence
 * contract, the lull gate and the absorption ledger are all here so a test
 * can reach every rule. The components in this directory render what these
 * decide.
 */

// ── the layout preference ──────────────────────────────────────────────────

export type HudLayout = 'glance' | 'full'

const LAYOUT_KEY = 'callrise.hud.layout'
const TRANSCRIPT_KEY = 'callrise.hud.transcriptCollapsed'

/** Glance is the default under the design preview; full is the switch. */
export function loadHudLayout(): HudLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'full' ? 'full' : 'glance'
  } catch {
    return 'glance'
  }
}
export function saveHudLayout(layout: HudLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout)
  } catch {
    /* a blocked store: the choice lasts the session */
  }
}
/** The founder's amendment: the transcript stays ON by default, collapsible, remembered. */
export function loadTranscriptCollapsed(): boolean {
  try {
    return localStorage.getItem(TRANSCRIPT_KEY) === '1'
  } catch {
    return false
  }
}
export function saveTranscriptCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(TRANSCRIPT_KEY, collapsed ? '1' : '0')
  } catch {
    /* same */
  }
}

// ── evidence: no cue without it ────────────────────────────────────────────

/** What a cue was made from. `heard` is a transcript excerpt (deterministic
 *  phrase match, or the other party's last turn a model cue was asked about);
 *  `measured` is a number with its window. Nothing else counts. */
export type CueEvidence =
  | { kind: 'heard'; quote: string }
  | { kind: 'measured'; label: string }

/** The glance line renders a cue only when this returns true. A cue with a
 *  blank quote or a blank measurement is a claim without a source. */
export function hasEvidence(e: CueEvidence | undefined | null): e is CueEvidence {
  if (!e) return false
  if (e.kind === 'heard') return e.quote.trim().length > 0
  return e.label.trim().length > 0
}

/** The excerpt is shown in smaller type beside the cue; keep it to a glance. */
export function trimQuote(quote: string, max = 72): string {
  const q = quote.replace(/\s+/g, ' ').trim()
  return q.length <= max ? q : q.slice(0, max - 1).trimEnd() + '…'
}

// ── lull-gated delivery ────────────────────────────────────────────────────

export interface LullInput {
  /** Monotonic ms now. */
  now: number
  /** Monotonic ms of the rep's most recent words (interim or final); null if none yet. */
  repLastSpokeAt: number | null
  /** Monotonic ms of the other party's most recent words; null if none yet. */
  otherLastSpokeAt: number | null
  /** How long the rep must have been silent for a cue to land. */
  holdMs?: number
}

/** A cue that is ready while the rep is speaking waits for the rep's lull:
 *  the other party's turn ended, or the rep has been silent for holdMs. A
 *  cue that fires over the rep's own sentence is worse than a late one. */
export function canDeliverNow(i: LullInput): boolean {
  const hold = i.holdMs ?? 1500
  if (i.repLastSpokeAt === null) return true // nobody has spoken yet; nothing to interrupt
  const repSilentFor = i.now - i.repLastSpokeAt
  if (repSilentFor >= hold) return true
  // the other party spoke after the rep: the rep is listening, not talking
  if (i.otherLastSpokeAt !== null && i.otherLastSpokeAt > i.repLastSpokeAt) return true
  return false
}

// ── the absorption instrument ──────────────────────────────────────────────

export type AbsorptionEvent =
  | { type: 'shown'; cueId: number; kind: string; at: number }
  | { type: 'useful'; cueId: number; kind: string; at: number }
  | { type: 'expired'; cueId: number; kind: string; at: number }
  | { type: 'dismissed'; cueId: number; kind: string; at: number }

const ABSORPTION_KEY = 'callrise.hud.absorption'
const ABSORPTION_CAP = 2000

export function loadAbsorption(): AbsorptionEvent[] {
  try {
    const raw = localStorage.getItem(ABSORPTION_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(parsed) ? (parsed as AbsorptionEvent[]) : []
  } catch {
    return []
  }
}

export function recordAbsorption(ev: AbsorptionEvent): void {
  try {
    const all = loadAbsorption()
    all.push(ev)
    localStorage.setItem(ABSORPTION_KEY, JSON.stringify(all.slice(-ABSORPTION_CAP)))
  } catch {
    /* the instrument never breaks the call */
  }
}

export interface AbsorptionSummary {
  shown: number
  useful: number
  expired: number
  dismissed: number
  /** useful / shown, or null when nothing was shown — never 0 for "no data". */
  usefulRate: number | null
  byKind: Record<string, { shown: number; useful: number; usefulRate: number | null }>
}

/** The number nobody has published: of the cues shown, how many did the rep
 *  mark useful — overall and per kind. Marking is one key while the cue is
 *  up (space) or a click on the line. */
export function summarizeAbsorption(events: ReadonlyArray<AbsorptionEvent>): AbsorptionSummary {
  const s: AbsorptionSummary = { shown: 0, useful: 0, expired: 0, dismissed: 0, usefulRate: null, byKind: {} }
  const usefulIds = new Set<number>()
  for (const e of events) {
    const k = (s.byKind[e.kind] ??= { shown: 0, useful: 0, usefulRate: null })
    if (e.type === 'shown') {
      s.shown++
      k.shown++
    } else if (e.type === 'useful') {
      if (usefulIds.has(e.cueId)) continue // one mark per cue
      usefulIds.add(e.cueId)
      s.useful++
      k.useful++
    } else if (e.type === 'expired') s.expired++
    else if (e.type === 'dismissed') s.dismissed++
  }
  s.usefulRate = s.shown > 0 ? s.useful / s.shown : null
  for (const k of Object.values(s.byKind)) k.usefulRate = k.shown > 0 ? k.useful / k.shown : null
  return s
}

// ── who is talking ─────────────────────────────────────────────────────────

export type Speaking = 'you' | 'them' | 'unsure' | 'nobody'

/** From the most recent turn: the rep, the other party, or — kept visible on
 *  purpose — unsure. Never smoothed into a guess. */
export function whoIsSpeaking(latest: { role?: 'rep' | 'other' | 'unknown'; at: number } | null, now: number, staleMs = 4000): Speaking {
  if (!latest || now - latest.at > staleMs) return 'nobody'
  if (latest.role === 'rep') return 'you'
  if (latest.role === 'other') return 'them'
  return 'unsure'
}

/** Talk share as measured WORDS by role (segments carry no durations); unsure
 *  words are excluded and reported so the bar never counts a guess. */
export function talkShare(segments: ReadonlyArray<{ role?: 'rep' | 'other' | 'unknown'; text: string }>): {
  youWords: number
  themWords: number
  unsureWords: number
  youShare: number | null
} {
  let you = 0
  let them = 0
  let unsure = 0
  for (const s of segments) {
    const n = (s.text.match(/\S+/g) ?? []).length
    if (s.role === 'rep') you += n
    else if (s.role === 'other') them += n
    else unsure += n
  }
  const known = you + them
  return { youWords: you, themWords: them, unsureWords: unsure, youShare: known > 0 ? you / known : null }
}
