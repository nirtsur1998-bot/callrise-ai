// BUG-108 (2026-08-24) — a TOTAL bound on the prompt.
//
// Every input to the coaching chat was capped individually and nothing
// capped the sum. The individual caps, all real and all verified on main:
//
//   transcript          100,000  coaching-chat.ts MAX_TRANSCRIPT_CHARS
//   inbound message       8,000  coaching-chat-ipc.ts:141
//   history COUNT            40  coaching-chat-ipc.ts MAX_HISTORY_MESSAGES
//   persisted message    16,000  calls-fs.ts MAX_CHAT_TEXT
//
// The trap is that the entry cap (8,000) and the persistence cap (16,000)
// disagree, and the REPLAY path enforces neither — coaching-chat-ipc.ts:199
// and :208 are a bare `map((m) => ({ role: m.role, content: m.text }))`, so
// `.slice(-40)` bounds the count and nothing bounds each message's length on
// the way back in. A 16,000-char persisted turn replays at 16,000.
//
// 16,000 is genuinely reachable, not just type-level: the follow-up-email
// path (coaching-chat-ipc.ts:419) persists an assistant-role turn produced by
// generatePostCallBrief, whose own maxTokens:4096 is ~16,000 chars — exactly
// the persistence cap, and never routed through coaching's maxTokens:2048.
//
// So the ceiling is 20 user x 8,000 + 20 assistant x 16,000 = 480,000 of
// history, + 100,000 transcript + 8,000 message = 588,000 chars ~= 147,000
// tokens at 4 chars/token, against catalog entries declaring a 128,000-token
// window. It does not fit even at the OPTIMISTIC density constant. Counting
// the rest of the system prompt (call notes <= 20,000, KYC <= ~8,000, the
// scorecard, Sales Brain) it is nearer 620,000.
//
// What overflow costs: the provider returns 400, failure-class.ts:41
// classifies status >= 400 as 'structural', and the walk marks that model
// broken and re-sends the IDENTICAL oversize prompt to the next entry,
// blacklisting each in turn. The user sees only AllModelsExhaustedError,
// which never mentions size.
//
// Blast radius — TWO ANSWERS, and the one that matters for users is the
// worse one. State both or neither.
//
//   In the field: EVERY purpose goes dark for 4 hours. The released build is
//   v1.3.3 (tag a084ad8), and `8192f85` is NOT an ancestor of it — verified,
//   not assumed. Every installed copy keys `structuralBreaks` by catalogId
//   alone, so one oversize coaching prompt blacklists that model for live
//   cues, summaries, tasks, everything — exactly as BUG-097 did.
//
//   On main: coaching chat only. `cf053b9` (containing `8192f85`) re-keyed
//   the map `purpose\0catalogId`. Merged, and at the time of writing
//   UNRELEASED — main is 6 commits ahead of the tag.
//
// So containment is real but not yet reaching anyone, and the two states
// diverge until a release ships. An earlier draft of this comment stated
// only the main-branch answer and was quietly wrong about every machine
// running the app. Containment limits the damage anyway; it never prevents
// the overflow, which is what this module is for.
//
// MERGE-BOUNDARY OBLIGATION. claude/m28-rise carries its own copy of this
// module at the same path, written first, for the Rise assistant. THIS file
// is the canonical one: it takes the trim direction as a parameter precisely
// so both features can share one budget instead of keeping two numbers that
// are supposed to agree. At the M28 merge the resolution is "keep this file,
// pass trimFrom:'tail' at Rise's call site" — NOT reconciling two diverged
// copies. Two constants that must agree, in two files, with nothing linking
// them, is the exact drift this module exists to end; do not re-create it.
//
// This module is pure and has no imports on purpose: the trimming policy is
// the part worth testing directly, and it should be provable without standing
// up a conversation, a provider, or a catalog.

export interface BudgetMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Which END of the trimmable section to CUT when it has to shrink.
 *
 * 'head' — coaching chat. The section is the TRANSCRIPT, and the most recent
 *   speech is what a coach is usually being asked about, so the start of the
 *   call is what gives way. Note transcriptText() keeps the END for the same
 *   reason, so both layers agree on one principle rather than fighting.
 * 'tail' — the Rise assistant. The section is appended attachment text, and
 *   cutting the head there would drop SCOPE_RULE, the instruction that stops
 *   one client's data being discussed in another client's chat.
 */
export type TrimFrom = 'head' | 'tail'

export interface PromptBudgetInput {
  /** Every system-prompt char that is NOT the trimmable section — rules,
   *  scope, scorecard, KYC, past calls, notes. Treated as a floor: this is
   *  never cut, so a caller whose fixed section alone exceeds the budget
   *  cannot be rescued here (see the `fits` field). */
  systemFixed: string
  /** The one bulky section the budget may shrink. Carries NO truncation
   *  marker — the caller composes that, so the marker wording lives with the
   *  feature and a second trim can never leave a fragment of a first one. */
  trimmable: string
  history: BudgetMessage[]
  /** The turn's own message. Never trimmed here — it is already capped
   *  upstream, and silently truncating what the user just typed is the one
   *  degradation they would actually notice. */
  message: string
}

export interface PromptBudgetResult {
  trimmable: string
  history: BudgetMessage[]
  /** What had to give, for logging and for the tests to assert on. */
  trim: {
    historyMessagesDropped: number
    trimmableCharsDropped: number
    /** True when anything at all was trimmed. */
    trimmed: boolean
  }
  /** True when the history handed IN already began on an assistant turn —
   *  i.e. the user/assistant pairing invariant was broken before this module
   *  touched anything.
   *
   *  The repair below makes such a history correct; this flag is what stops
   *  it also making it INVISIBLE. Without it, an odd cap, a single unpaired
   *  append, or a new consumer would be silently absorbed, and the only
   *  evidence would be a turn quietly going missing — the bug becomes
   *  undetectable rather than fixed.
   *
   *  Deliberately NOT set for the routine case where an odd number of drops
   *  lands on an assistant boundary. That is the guard doing its ordinary job
   *  on well-formed input, and counting it would bury the real signal in
   *  noise. Only a genuine invariant violation is reported. */
  historyStartedOnAssistant: boolean
  /** False when the fixed section plus the current message ALONE exceed the
   *  budget — nothing this module is allowed to cut can fix that, so it is
   *  reported rather than hidden behind a result that looks fitted. */
  fits: boolean
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
 * above. 70% of a 128,000-token window is ~89,600 tokens (358,400 chars),
 * far above any ordinary turn and far below the ~147,000 tokens that used to
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

/** One wording family for every truncation notice, so the two features
 *  cannot drift into describing the same event differently. The founder's
 *  condition on this fix: when a transcript IS truncated the prompt must say
 *  so explicitly, because a coach reasoning about a call it cannot fully see
 *  should know that rather than confidently characterising an opening it
 *  never read. */
export function truncationMarker(whatWasOmitted: string): string {
  return `[Context truncated to fit the model's limit — ${whatWasOmitted} was omitted.]`
}

function sizeOf(
  systemFixed: string,
  trimmable: string,
  history: BudgetMessage[],
  message: string
): number {
  let n = systemFixed.length + trimmable.length + message.length
  for (const m of history) n += m.content.length
  return n
}

/**
 * Fit a prompt into `budgetChars`, degrading in a fixed priority order:
 *
 *   1. Drop history, OLDEST first. Recent turns carry the thread; the oldest
 *      are the cheapest thing to lose and the least likely to be referenced.
 *   2. Only if it still overflows, shrink `trimmable`, cutting the end named
 *      by `trimFrom`.
 *
 * The current message and `systemFixed` are never touched.
 *
 * History is never left starting on an assistant turn. Turns are persisted in
 * user/assistant PAIRS, so an unguarded one-at-a-time drop can land on an odd
 * boundary and hand the provider a sequence that still ALTERNATES but begins
 * on an assistant turn — itself invalid, and the failure coaching-chat-ipc.ts
 * already documents at its userMode assignment. It looks fine in a debugger,
 * which is exactly why it survives review. Trading one extra dropped turn for
 * that is free, and REPAIRING here beats asserting: this runs mid-call, so a
 * turn the rep is waiting on should be fixed, not failed.
 *
 * Worth knowing before changing anything nearby: FOUR existing consumers
 * already depend on that pairing invariant and NONE of them enforce, assert or
 * mention it — the advisor-history mode filter and trailingPracticeMessages()
 * remove whole pairs only because a pair can never straddle two modes, and
 * MAX_HISTORY_MESSAGES (40) and MAX_CHAT_MESSAGES (300) land on even offsets
 * only because both happen to be EVEN. Make either odd, or append a single
 * unpaired message anywhere, and all four break silently. (Enumerated by the
 * M29 session while this was being written; the same latent bug was found and
 * fixed in Rise's own trimmer at ede2deb.)
 */
export function fitPromptToBudget(
  input: PromptBudgetInput,
  budgetChars: number,
  trimFrom: TrimFrom
): PromptBudgetResult {
  const { systemFixed, message } = input
  const history = [...input.history]
  let trimmable = input.trimmable
  let historyMessagesDropped = 0
  let trimmableCharsDropped = 0

  // Read BEFORE anything is dropped: this is the invariant violation itself,
  // not the routine odd-drop boundary the guard below also handles. Pure
  // boolean off an already-materialised array — it cannot throw, so it can
  // never alter the outcome of the call it is observing.
  const historyStartedOnAssistant = history.length > 0 && history[0].role === 'assistant'

  while (sizeOf(systemFixed, trimmable, history, message) > budgetChars && history.length > 0) {
    history.shift()
    historyMessagesDropped++
  }
  if (history.length > 0 && history[0].role === 'assistant') {
    history.shift()
    historyMessagesDropped++
  }

  const overflow = sizeOf(systemFixed, trimmable, history, message) - budgetChars
  if (overflow > 0) {
    const keep = Math.max(0, trimmable.length - overflow)
    trimmableCharsDropped = trimmable.length - keep
    trimmable = trimFrom === 'head' ? trimmable.slice(trimmable.length - keep) : trimmable.slice(0, keep)
  }

  return {
    trimmable,
    history,
    trim: {
      historyMessagesDropped,
      trimmableCharsDropped,
      trimmed: historyMessagesDropped > 0 || trimmableCharsDropped > 0
    },
    historyStartedOnAssistant,
    fits: sizeOf(systemFixed, trimmable, history, message) <= budgetChars
  }
}
