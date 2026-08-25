// BUG-096 fix C — the NOTICE text, split into a leaf with no runtime imports.
//
// Detection needs contacts, the memory DB and app settings. Formatting needs
// none of that, and keeping them together made the pure half unusable without
// the heavy half: the turn test mocks the detector but wants the REAL notice
// (asserting mock text would prove nothing), and `importOriginal()` therefore
// dragged electron and the memory runtime into a test that mocks both. That
// pushed a scoped-conversation test past the 5s timeout under full-suite load
// — passing 3/3 in isolation, failing in the suite.
//
// Same split, and the same reason, as capability-copy.ts: when the only way
// to assert real copy is to load a subsystem the test replaced, the copy is
// in the wrong module.
import type { LookupSection } from './tools'

export interface UnboundClientMention {
  contactId: string
  label: string
  /** How many memories this client actually has. 0 = none exist; > 0 = they
   *  exist and are simply unreachable from an unbound conversation. */
  memoryCount: number
}

/**
 * The CONTEXT section that tells the model what it cannot see and why.
 *
 * Instructing rather than answering: this does not put the client's data in
 * the prompt (it has none to put), it tells the model to STOP answering from
 * general context and say what is actually true. That is the whole fix —
 * BUG-096's damage was never the missing recall, it was the confident answer
 * built from the wrong memories.
 */
export function unboundClientNotice(mentions: UnboundClientMention[]): LookupSection | null {
  if (mentions.length === 0) return null
  const lines = mentions.map((m) => ({
    text:
      m.memoryCount > 0
        ? `${m.label}: ${m.memoryCount} memor${m.memoryCount === 1 ? 'y' : 'ies'} exist for this client, but they are NOT reachable in this conversation because it is not bound to them.`
        : `${m.label}: no memories have been learned about this client yet — there is nothing to reach, in this conversation or any other.`
  }))
  return {
    title: 'CLIENTS NAMED IN THE QUESTION THAT THIS CONVERSATION CANNOT REACH',
    lines: [
      ...lines,
      {
        text:
          'This chat is not bound to a client, so client-specific memories are out of scope for it. ' +
          'Say this plainly instead of answering from general context, and keep the distinction above: ' +
          '"memories exist but are out of reach here" means the user should open a chat scoped to that ' +
          'client from their record; "nothing learned yet" means there is nothing to open. ' +
          'Do NOT present rep-wide or business-wide facts as if they were about this client.'
      }
    ]
  }
}
