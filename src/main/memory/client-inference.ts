/**
 * M36 Stage 3 — infer WHICH CLIENT a question is about, from the question.
 *
 * WHY. rag.ts adds a client scope only when the conversation is bound to a
 * contact. Rise's default "New chat" is bound to nobody, so every client:*
 * memory is unreachable there by construction: the retrieval harness
 * measured 8/14 (57%) unbound against 13/14 (93%) bound (2026-09-06, before
 * this file). Most unbound questions name the client — "Who decides at
 * Acme?", "What did Dana say?" — so the scope can be recovered from the words
 * the user typed, and ONLY from those words: a question that names nobody
 * ("Do they need SOC 2?") stays unscoped, which is what keeps client A's
 * conversation from surfacing client B's memories.
 *
 * Pure. The directory is built from the contacts on disk by the caller.
 */

export interface ClientDirectoryEntry {
  contactId: string
  /** Lower-cased phrases that identify this client: the company, and each
   *  name token of three letters or more. Generic words are excluded. */
  keys: string[]
}

/** Words that appear in company and personal names but identify no one. */
const GENERIC = new Set([
  'the', 'and', 'inc', 'llc', 'ltd', 'co', 'corp', 'company', 'group', 'team', 'solutions',
  'services', 'systems', 'global', 'international', 'holdings', 'partners', 'consulting',
  'mr', 'mrs', 'ms', 'dr', 'von', 'van', 'del', 'della', 'new', 'north', 'south', 'east', 'west',
  // industry nouns: they name a sector, not a client
  'logistics', 'software', 'technologies', 'technology', 'industries', 'media', 'labs', 'digital',
  'capital', 'ventures', 'enterprises', 'bank', 'insurance', 'health', 'healthcare', 'energy',
  'motors', 'foods', 'retail', 'agency', 'studio', 'studios', 'network', 'networks', 'trading'
])

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3)
}

export function buildClientDirectory(
  contacts: ReadonlyArray<{ id: string; name?: string; company?: string }>
): ClientDirectoryEntry[] {
  return contacts.map((c) => {
    const keys: string[] = []
    const company = (c.company ?? '').trim().toLowerCase()
    if (company) {
      const companyTokens = tokens(company).filter((t) => !GENERIC.has(t))
      // the whole company phrase, when it carries at least one identifying token
      if (companyTokens.length > 0 && /\s/.test(company)) keys.push(company)
      for (const t of companyTokens) if (!keys.includes(t)) keys.push(t)
    }
    for (const t of tokens(c.name ?? '')) if (!GENERIC.has(t) && !keys.includes(t)) keys.push(t)
    return { contactId: c.id, keys }
  })
}

/** Contact ids named in the question, in order of first mention, once each. */
export function inferClientIds(question: string, directory: ReadonlyArray<ClientDirectoryEntry>): string[] {
  if (!question.trim() || directory.length === 0) return []
  const q = ' ' + question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') + ' '
  const hits: Array<{ contactId: string; at: number }> = []
  for (const entry of directory) {
    let best = -1
    for (const key of entry.keys) {
      const at = q.indexOf(' ' + key + ' ')
      if (at >= 0 && (best < 0 || at < best)) best = at
    }
    if (best >= 0) hits.push({ contactId: entry.contactId, at: best })
  }
  hits.sort((a, b) => a.at - b.at)
  const out: string[] = []
  for (const h of hits) if (!out.includes(h.contactId)) out.push(h.contactId)
  return out
}
