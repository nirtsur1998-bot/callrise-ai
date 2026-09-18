import type { CrmNoteHeader, CrmNoteJobResult, CrmNoteSections } from '../../../../preload/index.d'

// The clipboard side of the CRM note. Main renders the PLAIN TEXT
// (src/main/crm-note-format.ts) because that is what gets stored on the job
// and saved onto the contact; this file adds the two flavours only a clipboard
// needs, plus the fallback for notes drafted before sections existed.
//
// WHY BOTH FLAVOURS. The founder's complaint was that a pasted note arrives as
// "one long row" in another CRM. Two different things cause that, and both are
// fixed here: the note had no line breaks at all (fixed by sections), and a
// plain-text paste into a RICH-TEXT field collapses single newlines anyway,
// because HTML does not honour them. So a copy writes text/plain AND text/html
// — the destination keeps whichever it understands, and a rich-text CRM field
// gets real <ul> bullets instead of a run-on line.

/** Mirrors CRM_NOTE_SECTIONS in src/main/crm-note-format.ts — the renderer
 *  cannot import from src/main (tsconfig.web.json's scope), which is the same
 *  constraint holdsUnreviewedOutput.ts and tier1-types.ts already live with.
 *  A test reads both files and fails if the two lists ever drift. */
export const CRM_NOTE_SECTIONS: readonly (readonly [keyof CrmNoteSections, string])[] = [
  ['needs', 'What they need'],
  ['discussed', 'Discussed'],
  ['concerns', 'Concerns'],
  ['stakeholders', "Who's involved"],
  ['status', 'Where it stands'],
  ['nextSteps', 'Next steps']
] as const

export function crmNoteHeaderLine(header?: CrmNoteHeader): string {
  if (!header) return ''
  return [header.contactName && `Call with ${header.contactName}`, header.callDate]
    .filter(Boolean)
    .join(' · ')
}

/** The note's parts, whatever generation produced it. A job drafted before
 *  sections shipped carries only the paragraph, and it still renders. */
export function sectionsOf(result: Pick<CrmNoteJobResult, 'note' | 'sections'>): CrmNoteSections {
  return result.sections ?? { summary: result.note.trim() }
}

export function isPlainNote(s: CrmNoteSections): boolean {
  return CRM_NOTE_SECTIONS.every(([key]) => !s[key])
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** For a rich-text CRM field: real headings, real lists. */
export function toHtml(sections: CrmNoteSections, header?: CrmNoteHeader): string {
  const blocks: string[] = []
  const head = crmNoteHeaderLine(header)
  if (head) blocks.push(`<p><strong>${escapeHtml(head)}</strong></p>`)
  if (sections.summary) blocks.push(`<p>${escapeHtml(sections.summary)}</p>`)
  for (const [key, label] of CRM_NOTE_SECTIONS) {
    const value = sections[key]
    if (!value) continue
    if (Array.isArray(value)) {
      blocks.push(
        `<p><strong>${label}</strong></p><ul>${value
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join('')}</ul>`
      )
    } else {
      blocks.push(`<p><strong>${label}</strong> ${escapeHtml(value)}</p>`)
    }
  }
  return blocks.join('')
}

/** For the tools that take markdown (Notion, Linear, most issue trackers). */
export function toMarkdown(sections: CrmNoteSections, header?: CrmNoteHeader): string {
  const blocks: string[] = []
  const head = crmNoteHeaderLine(header)
  if (head) blocks.push(`**${head}**`)
  if (sections.summary) blocks.push(sections.summary)
  for (const [key, label] of CRM_NOTE_SECTIONS) {
    const value = sections[key]
    if (!value) continue
    if (Array.isArray(value)) {
      blocks.push([`**${label}**`, ...value.map((item) => `- ${item}`)].join('\n'))
    } else {
      blocks.push(`**${label}** ${value}`)
    }
  }
  return blocks.join('\n\n')
}

/**
 * Put the note on the clipboard as BOTH plain text and HTML, and say whether
 * it actually got there.
 *
 * BUG-288 — this does NOT use `navigator.clipboard`. That API is permission-
 * denied in this app and fails with NotAllowedError every time: the renderer
 * is a `file://` document and index.ts's permission handler grants `media` and
 * nothing else. Measured in the running app, both calls:
 *
 *   writeText -> NotAllowedError: Write permission denied
 *   write     -> NotAllowedError: Write permission denied
 *
 * The founder found it by pressing the button and pasting nothing. It went
 * unnoticed because a failed clipboard write looks exactly like a successful
 * one until you paste — so the return value here is not decoration: the caller
 * must not say "Copied" unless this returns true.
 */
export async function copyNote(text: string, html: string): Promise<boolean> {
  try {
    const res = await window.api.clipboard.write({ text, html })
    return !!res?.ok
  } catch {
    return false
  }
}
