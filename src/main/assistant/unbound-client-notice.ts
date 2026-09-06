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
// M36 Stage 3 (2026-09-06) — OPTION B IS ON, by the founder's decision. An
// unbound chat now SEARCHES the memories of the clients the question names
// (client-inference.ts → rag.ts inferredClientIds). The notice's job changed
// with it, under the founder's third condition — "keep C's honest refusal as
// the fallback": it now says which clients were searched and why (never a
// silent widening), keeps "nothing learned yet" for a named client with no
// memories, and — when the question names nobody — tells the model to say it
// cannot reach a client from here rather than answer a client question from
// general context.
import type { LookupSection } from './tools'

export interface UnboundClientMention {
  contactId: string
  label: string
  /** How many memories this client has. 0 = nothing learned yet; > 0 = these
   *  were searched for this question because the question named the client. */
  memoryCount: number
}

/**
 * The CONTEXT section for an UNBOUND conversation.
 *
 * With mentions: the named clients' memories were searched — say so, so the
 * widening is never silent; a named client with no memories is still "nothing
 * learned yet", not "out of reach".
 *
 * Without mentions: option C's refusal, kept as the fallback. The model is
 * told that no client scope was searched, so a question that is about a
 * specific client the words did not identify gets "I can't reach that client
 * from here" instead of a confident general answer.
 */
export function unboundClientNotice(mentions: UnboundClientMention[]): LookupSection {
  if (mentions.length === 0) {
    return {
      title: 'CLIENT SCOPE FOR THIS QUESTION',
      lines: [
        {
          text:
            'This chat is not bound to a client and the question did not name one that CallRise knows, so ' +
            'only rep-wide and business-wide memories were searched. If the user is asking about a specific ' +
            'client, say plainly that you cannot reach that client from here and that naming them, or opening ' +
            'a chat from their record, would — do NOT answer a client question from general context.'
        }
      ]
    }
  }
  const lines = mentions.map((m) => ({
    text:
      m.memoryCount > 0
        ? `${m.label}: ${m.memoryCount} memor${m.memoryCount === 1 ? 'y' : 'ies'} exist for this client and were searched for this question because the question named them.`
        : `${m.label}: no memories have been learned about this client yet — there is nothing to search, in this conversation or any other.`
  }))
  return {
    title: 'CLIENTS NAMED IN THE QUESTION — THEIR MEMORIES WERE SEARCHED',
    lines: [
      ...lines,
      {
        text:
          'Retrieved client memories carry their client; use them only for that client. A client with ' +
          '"nothing learned yet" has no facts to draw on — say so rather than inferring them from rep-wide ' +
          'or business-wide memories.'
      }
    ]
  }
}
