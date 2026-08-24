// AUDIT FIX (2026-08-24) — a TOTAL bound on the prompt.
//
// Every input was individually capped and nothing capped the sum. Measured
// against the real buildAssistantContext: the system prompt is 26,458 chars
// with no attachments and 267,016 chars with six text attachments
// (MAX_EXTRACTED_CHARS = 40,000 each, appended by context.ts with no cap of
// its own). Add history — MAX_HISTORY_MESSAGES 40 x MAX_INBOUND_CHARS 8,000 =
// 320,000 — plus the current message, and ~595,000 chars (~149,000 tokens)
// was reachable through the UI against models whose catalog entries declare a
// 128,000-token window. `contextWindow` was declared and then never read by
// any bound; its only consumer was a Settings label.
//
// Text attachments did not even trigger the existing history drop:
// assistant-ipc dropped history only for images and PDFs, so six documents
// and forty turns of history stacked.
//
// What overflow cost: the provider returns a 400, failure-class.ts classifies
// status >= 400 as 'structural', and the walk marks that model broken and
// then sends the SAME oversize prompt to the next one, blacklisting each in
// turn. Before structural breaks were purpose-scoped (same day, separate
// commit) that also took out live coaching. The user saw only
// AllModelsExhaustedError, which never mentions size.
//
// This module is pure and has no imports on purpose: the trimming policy is
// the part worth testing directly, and it should be provable without standing
// up a conversation, a provider, or a catalog.

export interface BudgetMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface PromptBudgetInput {
  system: string
  history: BudgetMessage[]
  /** The turn's own message. Never trimmed here — it is already capped
   *  upstream, and silently truncating what the user just typed is the one
   *  degradation they would actually notice. */
  message: string
}

export interface PromptBudgetResult {
  system: string
  history: BudgetMessage[]
  /** What had to give, for logging and for the tests to assert on. */
  trim: {
    historyMessagesDropped: number
    systemCharsDropped: number
    /** True when anything at all was trimmed. */
    trimmed: boolean
  }
  /**
   * AUDIT FIX (2026-08-25) — read BEFORE any dropping, so it reports a
   * GENUINELY broken pairing invariant (BUG-109) rather than the routine odd
   * drop this function creates itself and then repairs.
   *
   * Without the distinction the repair below is a detector that switches off
   * the thing it detects: an input whose history already started on an
   * assistant turn — which nothing on this branch should ever produce — would
   * be silently corrected and look identical to the benign case. Mirrored
   * from the coaching-chat module on `main`, whose author pointed out that my
   * trimmer had the same blind spot.
   */
  historyStartedOnAssistant: boolean
}

/**
 * Chars per token — a deliberate UNDER-estimate of token density (i.e. it
 * assumes 4 chars per token, so it treats text as cheaper than a worst case
 * would). English prose runs ~4; the risk is code, JSON and CJK, which run
 * denser. The safety margin below is what absorbs that, rather than picking a
 * pessimistic ratio here and having the budget bite on ordinary conversations.
 */
export const CHARS_PER_TOKEN = 4

/**
 * Fraction of the window this prompt may occupy. The remainder covers the
 * completion, the provider's own message scaffolding, and the ratio error
 * above. 70% of a 128,000-token window is ~89,600 tokens (~358,000 chars),
 * far above any ordinary turn and far below the ~149,000 tokens that used to
 * be reachable.
 */
export const PROMPT_WINDOW_FRACTION = 0.7

/** The window to assume when nothing better is known. The catalog's smallest
 *  declared window is 128,000 and nine of its twelve entries use it, so
 *  assuming it is both the common case and the conservative one. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000

export function budgetCharsFor(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * PROMPT_WINDOW_FRACTION * CHARS_PER_TOKEN)
}

function sizeOf(input: PromptBudgetInput): number {
  let n = input.system.length + input.message.length
  for (const m of input.history) n += m.content.length
  return n
}

/**
 * Fit a prompt into `budgetChars`, degrading in a fixed priority order:
 *
 *   1. Drop history, OLDEST first. Recent turns carry the thread; the
 *      oldest are the cheapest thing to lose and the least likely to be
 *      referenced.
 *   2. Only if the system prompt alone still overflows, truncate its TAIL,
 *      leaving a visible marker. The tail is where context.ts appends
 *      attachment text, so this cuts the bulky, most-recently-added material
 *      and leaves the rules, scope and profile sections at the top intact.
 *      Cutting the head instead would drop the SCOPE_RULE — the instruction
 *      that stops one client's data being discussed in another's chat.
 *
 * The current message is never touched.
 */
export function fitPromptToBudget(
  input: PromptBudgetInput,
  budgetChars: number
): PromptBudgetResult {
  const history = [...input.history]
  // Captured BEFORE the loop: afterwards it cannot be told apart from the
  // odd-drop boundary this function creates on its own.
  const historyStartedOnAssistant = history.length > 0 && history[0].role === 'assistant'
  let historyMessagesDropped = 0
  let systemCharsDropped = 0

  while (sizeOf({ ...input, history }) > budgetChars && history.length > 0) {
    history.shift()
    historyMessagesDropped++
  }

  // AUDIT FIX (2026-08-24) — never leave the history starting on an assistant
  // turn. Found by the BUG-108 hotfix session hitting the same latent bug in
  // coaching chat and telling me to check here; it was real.
  //
  // Turns persist in PAIRS (conversations-fs appendTurn writes user then
  // assistant), so dropping one at a time lands on an odd boundary half the
  // time and yields [assistant, user, assistant, …]. That still alternates,
  // which is why it is easy to miss — but the FIRST message being an
  // assistant turn is itself invalid for Anthropic's API, and
  // coaching-chat-ipc.ts:177 records providers rejecting malformed sequences
  // "outright as an invalid, non-alternating message sequence".
  //
  // Reachable, not theoretical: the budget genuinely bites on a maxed-out
  // conversation (320,000 history + 8,000 message + a ~26,458-char system
  // prompt leaves only ~1% margin), so odd-numbered drops happen in normal
  // use, not just at the type-level ceiling.
  //
  // Dropping one MORE can only shrink the prompt, so it cannot break the
  // budget invariant established above.
  if (history.length > 0 && history[0].role === 'assistant') {
    history.shift()
    historyMessagesDropped++
  }

  let system = input.system
  const overflow = system.length + input.message.length - budgetChars
  if (overflow > 0) {
    const marker =
      '\n\n[Context truncated to fit the model\'s limit — some attachment text was omitted.]'
    const keep = Math.max(0, system.length - overflow - marker.length)
    systemCharsDropped = system.length - keep
    system = system.slice(0, keep) + marker
  }

  return {
    system,
    history,
    trim: {
      historyMessagesDropped,
      systemCharsDropped,
      trimmed: historyMessagesDropped > 0 || systemCharsDropped > 0
    },
    historyStartedOnAssistant
  }
}
