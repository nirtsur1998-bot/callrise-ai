// The CRM note's SHAPE, and its plain-text rendering.
//
// THE COMPLAINT (founder, 2026-09-18): "when you copy and paste it it comes as
// one long row on a different CRM." That was true by construction, and nothing
// was being lost in transit — there was no structure to lose. The note was
// produced as one free-text string, because crm-note-length.ts asks the model
// for "2-3 sentences", so there were no line breaks for the other CRM to keep.
//
// A note with sections pastes as sections into any plain textarea, which is
// what almost every CRM note field is. The renderer adds the rich-text and
// markdown flavours for the clipboard (crmNoteFormat.ts); the PLAIN TEXT — the
// one the complaint is about, and the one saved onto the contact — is rendered
// here, once, so main and the renderer cannot disagree about it.
//
// No Electron import, like crm-note-length.ts next door, so it stays testable.

/** The drafted note as parts rather than a paragraph. Everything except
 *  `summary` is optional: a model that returns only prose still produces a
 *  usable note, and a schema's `required` list is not something the product may
 *  lean on (BUG-241 — a "required" field was absent on 4 of 9 real reports). */
/**
 * The sections, and why these ones. Researched 2026-09-18 against what sales
 * teams actually ask of a CRM note (Sybill, Copper, Weflow, Oliv — the
 * "TLDR + detail" / outcome-first pattern, and MEDDIC-style field mapping).
 * The agreement across all of them:
 *
 *   - Lead with the OUTCOME — what was decided or changed — not a recap.
 *   - Capture what the buyer NEEDS in their own words, especially quantified
 *     pain ("an hour a day just in updates"), because a paraphrase loses the
 *     number and the urgency that make it usable later.
 *   - Name who is involved: the decision-maker is the single most-missed field.
 *   - Objections belong in the record, not in the rep's memory.
 *   - CLOSE with next steps, each carrying an owner and a date — an action item
 *     buried in prose is an action item that gets missed.
 *   - Omit what the call did not cover. A padded note stops being trusted.
 */
export interface CrmNoteSections {
  /** Outcome first: what was decided or what changed. */
  summary: string
  /** What the buyer needs, in their words where they gave them. */
  needs?: string[]
  discussed?: string[]
  concerns?: string[]
  /** Who else is involved, and who actually decides. */
  stakeholders?: string[]
  /** Where the deal stands, plus timing. */
  status?: string
  /** Each one "who — what — when". */
  nextSteps?: string[]
}

/** What the note is about, so a pasted note identifies itself in a CRM that
 *  has never heard of CallRise. Absent on a legacy note. */
export interface CrmNoteHeader {
  contactName?: string
  callDate?: string
}

/** Section key -> heading, in the order a note reads. Mirrored in the
 *  renderer's crmNoteFormat.ts (the renderer cannot import from src/main —
 *  tsconfig.web.json's scope), and a test pins the two lists identical. */
export const CRM_NOTE_SECTIONS: readonly (readonly [keyof CrmNoteSections, string])[] = [
  ['needs', 'What they need'],
  ['discussed', 'Discussed'],
  ['concerns', 'Concerns'],
  ['stakeholders', "Who's involved"],
  ['status', 'Where it stands'],
  ['nextSteps', 'Next steps']
] as const

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const cleanList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(clean).filter(Boolean).slice(0, 8) : []

/** Accept whatever the model actually returned; validate in code, never trust
 *  the tool schema's `required`. Returns null when there is no usable note. */
export function sanitizeSections(input: unknown): CrmNoteSections | null {
  if (!input || typeof input !== 'object') return null
  const v = input as Record<string, unknown>
  const summary = clean(v.summary)
  if (!summary) return null
  const out: CrmNoteSections = { summary }
  const needs = cleanList(v.needs)
  const discussed = cleanList(v.discussed)
  const concerns = cleanList(v.concerns)
  const stakeholders = cleanList(v.stakeholders)
  const nextSteps = cleanList(v.nextSteps)
  const status = clean(v.status)
  if (needs.length) out.needs = needs
  if (discussed.length) out.discussed = discussed
  if (concerns.length) out.concerns = concerns
  if (stakeholders.length) out.stakeholders = stakeholders
  if (status) out.status = status
  if (nextSteps.length) out.nextSteps = nextSteps
  return out
}

/** A paragraph-only note — every note generated before this feature, and every
 *  note from the auto-note-on-save path — renders through the same code. */
export function legacySections(note: string): CrmNoteSections {
  return { summary: note.trim() }
}

/** True when there is nothing but the paragraph, so the card can skip its
 *  section chrome instead of drawing empty headings. */
export function isPlainNote(s: CrmNoteSections): boolean {
  return CRM_NOTE_SECTIONS.every(([key]) => !s[key])
}

export function crmNoteHeaderLine(header?: CrmNoteHeader): string {
  if (!header) return ''
  return [header.contactName && `Call with ${header.contactName}`, header.callDate]
    .filter(Boolean)
    .join(' · ')
}

/**
 * The plain-text note: a blank line between blocks, a heading per section, and
 * a "• " on every bullet. That is what survives a paste into a textarea, an
 * email body, or a CRM note field — and it is precisely what a single
 * paragraph could not do.
 */
export function formatCrmNoteText(sections: CrmNoteSections, header?: CrmNoteHeader): string {
  const blocks: string[] = []
  const head = crmNoteHeaderLine(header)
  if (head) blocks.push(head)
  if (sections.summary) blocks.push(sections.summary)
  for (const [key, label] of CRM_NOTE_SECTIONS) {
    const value = sections[key]
    if (!value) continue
    if (Array.isArray(value)) blocks.push([`${label}:`, ...value.map((i) => `• ${i}`)].join('\n'))
    else blocks.push(`${label}: ${value}`)
  }
  return blocks.join('\n\n')
}
