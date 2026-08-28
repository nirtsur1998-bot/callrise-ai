// AUDIT FIX (2026-08-24) — the "your keys exist, none of them can run THIS
// request" copy, in a leaf module with no dependencies.
//
// It lived inside complete-with-fallback.ts and was ALSO copy-pasted into
// assistant-ipc.ts, so the same sentence existed twice and the two could
// drift. They had not drifted — they agreed on advice that was actively
// harmful ("send the file as text or PDF instead" steered users into the
// ungated PDF path that blacklisted their models for four hours).
//
// Kept dependency-free on purpose: assistant-ipc's tests mock
// complete-with-fallback wholesale, so had this stayed there, the only way to
// assert the user-facing message would have been against a mock of it — a
// test that passes whatever the copy says. From here the real text is
// reachable from both sides.
import type { ChainCapabilityNeeds } from './capability-needs'

/** Names the actual missing capability instead of blaming tool-calling for
 *  everything, and never recommends a path that is itself gated. */
export function noCapableModelMessage(needs: ChainCapabilityNeeds): string {
  if (needs.needsDocument) {
    return 'None of your configured AI models can read PDFs. Add a Claude, ChatGPT, or Gemini key in Settings, or paste the relevant text into the message instead.'
  }
  if (needs.needsVision) {
    // BUG-125 audit (2026-08-28) — the Scout suggestion is REMOVED because it is
    // currently impossible: groq-llama-4-scout is knownStale in the catalog and
    // both chain builders skip knownStale entries, so assigning it in Settings
    // cannot work. Advice that cannot work is worse than no advice — it is the
    // same shape as "add another provider's key" was before BUG-125b. Restore
    // it only when the entry's staleness is resolved against Groq's live list.
    return 'None of your configured AI models can read images. Add a Claude, ChatGPT, or Gemini key in Settings, or paste the relevant text into the message instead.'
  }
  return "Every model configured for this can't run this request (tool-calling not supported by any of them) — reassign a model in Settings."
}
