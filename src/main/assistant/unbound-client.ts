// BUG-096 fix C (2026-08-25) — say so when a question names a client that
// this conversation cannot reach.
//
// THE PROBLEM. Rise passes `scope?.contactId ?? null` to retrieval, and
// rag.ts builds its scope list as
// `['rep','business', ...(contactId ? [clientScope(contactId)] : [])]`. So in
// the DEFAULT unbound "New chat", every `client:*` memory is unreachable by
// construction. Measured: recall drops from 13/14 to 8/14, and — the part
// that matters — empty answers stay 0/13. The client questions do not come
// back empty, they come back with generic business memories, and Rise answers
// confidently from the wrong context instead of saying it does not know.
//
// WHY THIS SHAPE (option C, founder's decision). It does NOT touch retrieval
// scope. The cross-client invariant is untouched BY CONSTRUCTION rather than
// by care: nothing here widens what retrieval may see, it only adds a note
// telling the model what it is missing and why. Auto-binding the conversation
// (option B) is a separate, later change, and the founder's standing
// constraint on it is that an auto-bind is NEVER silent.
//
// THE HONESTY REQUIREMENT, also the founder's. "No memories exist" and "none
// are reachable in this mode" suggest DIFFERENT user actions — the first
// means go have the conversation, the second means open a scoped chat — so
// the note distinguishes them rather than collapsing both into "I don't
// know". Counting a client's memories from an unbound chat is not a
// cross-client leak: it reports existence to the account owner about their
// own data, and no other client's content enters the prompt.
import { listContacts, type Contact } from '../contacts-fs'
import { getMemoryDb } from '../memory/memory-runtime'
import { isSalesBrainEnabled } from '../app-settings'
import { listMemories } from '../memory/memories-store'
import { clientScope } from '../memory/types'
import { buildClientDirectory } from '../memory/client-inference'
import type { UnboundClientMention } from './unbound-client-notice'

/** The phrases a contact can be recognised by — the company, and each name
 *  token of three letters or more, generic words excluded. ONE source for
 *  this, shared with retrieval's client inference (M36 Stage 3): two
 *  detectors for one question would be taxonomy species 42. Before M36 this
 *  matched only the full name or company, so "What did Dana say?" named
 *  nobody. */
function candidateTerms(c: Contact): string[] {
  return buildClientDirectory([c])[0]?.keys ?? []
}

/** Whole-word, case-insensitive. Substring matching would fire on "Art" inside
 *  "start", which would put a spurious note in front of the model on ordinary
 *  questions — worse than the silence it replaces. */
function mentions(message: string, term: string): boolean {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(message)
}

export type { UnboundClientMention } from './unbound-client-notice'

/**
 * Which known clients does this message name? Empty when the conversation is
 * scoped (the caller must not call it then), when nothing matches, or when
 * the contact store cannot be read.
 */
export async function detectUnboundClientMentions(
  message: string,
  contactsDir: string
): Promise<UnboundClientMention[]> {
  const contacts = await listContacts(contactsDir).catch(() => [] as Contact[])
  const db = isSalesBrainEnabled() ? getMemoryDb() : null
  const out: UnboundClientMention[] = []
  for (const c of contacts) {
    const term = candidateTerms(c).find((t) => mentions(message, t))
    if (!term) continue
    let memoryCount = 0
    if (db) {
      try {
        memoryCount = listMemories(db, { scope: clientScope(c.id) }).length
      } catch {
        memoryCount = 0
      }
    }
    out.push({
      contactId: c.id,
      label: c.company && c.company !== c.name ? `${c.name} (${c.company})` : c.name,
      memoryCount
    })
    if (out.length >= 3) break // a note, not a directory listing
  }
  return out
}

export { unboundClientNotice } from './unbound-client-notice'
