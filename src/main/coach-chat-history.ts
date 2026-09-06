// Pure helpers for the coach chat's model history — no Electron, so they can
// be tested directly (coaching-chat-ipc.ts cannot be imported under vitest).

/**
 * BUG-109 — the pairing invariant, ENFORCED at the one place it matters.
 *
 * Every coach-chat persist writes a user turn and an assistant turn together
 * (appendCoachChatTurn), so the history alternates user/assistant and has an
 * even length. Four consumers here silently depend on that: `.slice(-40)` off
 * an even array lands on a user turn; the practice-tail walk assumes pairs;
 * the advisor filter removes whole pairs. Change 40 to 41, or drop one message
 * anywhere, and the slice starts on an ASSISTANT turn — still alternating, so
 * it survives review, but a leading assistant message is invalid for the
 * provider. It has happened once already (BUG-098's prompt budget, fixed at
 * that call site alone). This makes the guarantee explicit: whatever the
 * upstream shape, the model never sees a history that opens on the assistant.
 */
export function startOnUserTurn<T extends { role: 'user' | 'assistant' }>(history: T[]): T[] {
  const first = history.findIndex((m) => m.role === 'user')
  if (first === -1) return [] // no user turn at all: nothing the model may see
  return first === 0 ? history : history.slice(first)
}
