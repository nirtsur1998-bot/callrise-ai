// M23 Workstream C — how long a generated CRM note should be. Same
// tuple/label/sanitize/instruction-fragment shape as summary-language.ts
// (the closest existing precedent for a settings-driven prompt-instruction
// enum in this codebase), just for note length instead of language.

export const CRM_NOTE_LENGTHS = ['short', 'medium', 'detailed'] as const

export type CrmNoteLength = (typeof CRM_NOTE_LENGTHS)[number]

export const CRM_NOTE_LENGTH_LABEL: Record<CrmNoteLength, string> = {
  short: 'Short',
  medium: 'Medium',
  detailed: 'Detailed'
}

const LENGTH_SET = new Set<CrmNoteLength>(CRM_NOTE_LENGTHS)

export function sanitizeCrmNoteLength(value: unknown): CrmNoteLength {
  return typeof value === 'string' && LENGTH_SET.has(value as CrmNoteLength)
    ? (value as CrmNoteLength)
    : 'medium'
}

/** The length clause spliced into both the tool-call schema description and
 *  the generation prompt. 'medium' describes the exact length crm-notes.ts
 *  always produced before this toggle existed, so any caller that doesn't
 *  pass a length keeps the same output shape it always had. */
export function crmNoteLengthClause(length: CrmNoteLength): string {
  switch (length) {
    case 'short':
      return 'ONE sentence — only the single most important thing to remember before the next call'
    case 'detailed':
      return (
        'a detailed paragraph (5-8 sentences) covering what was discussed, key points raised, ' +
        'objections or concerns, and where things stand'
      )
    case 'medium':
    default:
      return '2-3 sentences: what was discussed, where things stand, and anything worth remembering before the next call'
  }
}

/** Output-token budget per length — 'medium' matches crm-notes.ts's original
 *  fixed maxTokens exactly; 'detailed' gets headroom so a longer note isn't
 *  cut off mid-sentence by the token cap. */
export function crmNoteMaxTokens(length: CrmNoteLength): number {
  switch (length) {
    case 'short':
      return 150
    case 'detailed':
      return 900
    case 'medium':
    default:
      return 512
  }
}
