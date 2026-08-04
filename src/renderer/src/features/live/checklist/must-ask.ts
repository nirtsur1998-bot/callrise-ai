// The question-not-asked checklist (§4.5).
//
// Five things a discovery call has to establish. The rep knows all five; what
// they lose is track of which ones they have actually covered, because they are
// listening rather than auditing themselves. So this keeps the count, quietly,
// and says something only at the end — when there is still time to ask.
//
// Ambient, never an interrupt. A checklist that interrupts to say "you haven't
// asked about budget" while the buyer is mid-sentence about budget is worse
// than no checklist. It fills in as the call goes and the only moment it
// speaks up is before hanging up.
//
// Deterministic keyword matching handles the cheap 80%. It is intentionally
// scored on the REP's words: the item is "did you ask", and a buyer
// volunteering their timeline unprompted is genuinely a different thing from
// the rep establishing it — though the buyer's answer does count as covered,
// because the goal is the information, not the credit.

import { normalize } from '../battlecards/match'

export type MustAskId = 'budget' | 'timeline' | 'decision-process' | 'competition' | 'success'

export interface MustAskItem {
  id: MustAskId
  /** Shown in the checklist. */
  label: string
  /** What the rep is told they missed, phrased as the thing to do. */
  missedPrompt: string
  /** Phrases that count as having covered it. */
  patterns: string[]
}

export const MUST_ASK: MustAskItem[] = [
  {
    id: 'budget',
    label: 'Budget',
    missedPrompt: 'You never asked what they have budgeted.',
    patterns: [
      'budget',
      'how much were you looking to spend',
      'price range',
      'what would you be comfortable spending',
      'allocated for this',
      'cost centre',
      'cost center'
    ]
  },
  {
    id: 'timeline',
    label: 'Timeline',
    missedPrompt: 'You never asked about their timeline.',
    patterns: [
      'timeline',
      'time frame',
      'timeframe',
      'when would you want',
      'when are you looking to',
      'how soon',
      'go live',
      'by when',
      'target date'
    ]
  },
  {
    id: 'decision-process',
    label: 'Decision process',
    missedPrompt: 'You never asked how the decision gets made.',
    patterns: [
      'decision process',
      'who else is involved',
      'who signs',
      'sign off',
      'signoff',
      'decision maker',
      'how do decisions',
      'who needs to approve',
      'approval process'
    ]
  },
  {
    id: 'competition',
    label: 'Competition',
    missedPrompt: 'You never asked who else they are looking at.',
    patterns: [
      'who else are you',
      'other vendors',
      'evaluating anyone else',
      'compared to',
      'alternatives',
      'currently using',
      'incumbent',
      'shortlist'
    ]
  },
  {
    id: 'success',
    label: 'Success criteria',
    missedPrompt: 'You never asked what success would look like.',
    patterns: [
      'success look like',
      'what would good look like',
      'how would you measure',
      'what are you hoping to',
      'the outcome you',
      'define success',
      'what does winning'
    ]
  }
]

export interface ChecklistState {
  covered: ReadonlySet<MustAskId>
  /** In list order, so the UI never reorders under the rep's eye. */
  missing: MustAskItem[]
  /** 0–1, for an ambient progress bar. */
  progress: number
}

/** The state before a call has said anything — so a component can seed its
 *  own state without reaching into a checklist instance during render. */
export function emptyChecklistState(): ChecklistState {
  return { covered: new Set(), missing: [...MUST_ASK], progress: 0 }
}

/**
 * Tracks coverage across a call.
 *
 * Coverage is sticky by design: something asked in minute two is still asked in
 * minute forty. Un-checking an item because the topic drifted away would make
 * the checklist flicker, and a flickering checklist is one nobody trusts.
 */
export class MustAskChecklist {
  private readonly items: MustAskItem[]
  private readonly covered = new Set<MustAskId>()

  constructor(items: MustAskItem[] = MUST_ASK) {
    this.items = items
  }

  /**
   * Score a stretch of transcript. Returns the items newly covered by THIS
   * text, so a caller can react to the moment rather than diffing state.
   */
  observe(text: string): MustAskId[] {
    if (!text) return []
    const haystack = normalize(text)
    const newly: MustAskId[] = []
    for (const item of this.items) {
      if (this.covered.has(item.id)) continue
      if (item.patterns.some((p) => haystack.includes(normalize(p)))) {
        this.covered.add(item.id)
        newly.push(item.id)
      }
    }
    return newly
  }

  state(): ChecklistState {
    const missing = this.items.filter((i) => !this.covered.has(i.id))
    return {
      covered: new Set(this.covered),
      missing,
      progress: this.items.length === 0 ? 1 : this.covered.size / this.items.length
    }
  }

  reset(): void {
    this.covered.clear()
  }
}

/**
 * What to say before hanging up, or null when there is nothing worth saying.
 *
 * Silent when everything is covered — a checklist that congratulates you is
 * noise. Silent too when NOTHING is covered, because that is not a rep who
 * forgot five questions, it is a call that was not a discovery call (a demo, a
 * check-in, a wrong number), and listing all five at someone who never
 * intended to ask them is how a feature gets switched off.
 */
export function preHangupWarning(state: ChecklistState): string | null {
  const missing = state.missing
  if (missing.length === 0) return null
  if (state.covered.size === 0) return null
  if (missing.length === 1) return missing[0].missedPrompt
  const labels = missing.map((m) => m.label.toLowerCase())
  const last = labels.pop()
  return `Before you go: you haven't covered ${labels.join(', ')} or ${last}.`
}
