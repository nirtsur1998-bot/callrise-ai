// Who the rep is — assembled into AI context so summaries and coaching read
// like they understand the rep, not a generic salesperson. Simple architecture
// (no embeddings), same "assemble text, cap size" spirit as knowledge-context.ts.

export type Pronoun = 'he' | 'she' | 'they' | ''

export interface PersonalizationSettings {
  name: string
  role: string
  pronoun: Pronoun
  about: string
}

export const EMPTY_PERSONALIZATION: PersonalizationSettings = {
  name: '',
  role: '',
  pronoun: '',
  about: ''
}

const MAX_NAME = 100
const MAX_ROLE = 150
const MAX_ABOUT = 1500
const PRONOUNS = new Set<Pronoun>(['he', 'she', 'they', ''])
const PRONOUN_LABEL: Record<Exclude<Pronoun, ''>, string> = {
  he: 'he/him',
  she: 'she/her',
  they: 'they/them'
}

function sanitizeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function sanitizePronoun(value: unknown): Pronoun {
  return typeof value === 'string' && PRONOUNS.has(value as Pronoun) ? (value as Pronoun) : ''
}

/** Full sanitize — used when reading the settings file from disk. Missing or
 *  invalid fields collapse to empty, never to made-up data. */
export function sanitizePersonalization(value: unknown): PersonalizationSettings {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    name: sanitizeText(v.name, MAX_NAME),
    role: sanitizeText(v.role, MAX_ROLE),
    pronoun: sanitizePronoun(v.pronoun),
    about: sanitizeText(v.about, MAX_ABOUT)
  }
}

/** Partial-patch merge — only the keys present in `patch` are touched, so
 *  saving one field (e.g. just `name`) can never wipe out the others. */
export function mergePersonalization(
  current: PersonalizationSettings,
  patch: unknown
): PersonalizationSettings {
  if (!patch || typeof patch !== 'object') return current
  const p = patch as Record<string, unknown>
  return {
    name: 'name' in p ? sanitizeText(p.name, MAX_NAME) : current.name,
    role: 'role' in p ? sanitizeText(p.role, MAX_ROLE) : current.role,
    pronoun: 'pronoun' in p ? sanitizePronoun(p.pronoun) : current.pronoun,
    about: 'about' in p ? sanitizeText(p.about, MAX_ABOUT) : current.about
  }
}

/** Build the exact text block Claude is given as context. Empty string when
 *  nothing has been filled in — callers should skip adding it entirely. */
export function assemblePersonalizationContext(p: PersonalizationSettings): string {
  const lines: string[] = []
  if (p.name) lines.push(`Rep's name: ${p.name}`)
  if (p.role) lines.push(`Rep's role: ${p.role}`)
  if (p.pronoun)
    lines.push(`Preferred pronoun for the rep in written summaries: ${PRONOUN_LABEL[p.pronoun]}`)
  if (p.about) lines.push(`About the rep's sales role/style (in their own words):\n${p.about}`)
  if (!lines.length) return ''
  return `=== ABOUT THE REP (context only, not evidence) ===\n${lines.join('\n\n')}`
}
