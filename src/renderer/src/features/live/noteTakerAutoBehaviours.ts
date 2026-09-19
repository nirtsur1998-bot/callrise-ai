// AI Note Taker — the three opted-in auto-behaviours that run once a call
// record exists: summarize, title, post-call brief to the clipboard.
//
// BUG-230 — this used to be an inline block in useTranscription's save
// handler, so it ran for exactly one way a call record can come into
// existence: the rep ending a live call. A call RECOVERED from a journal after
// a crash (InterruptedCallPrompt → live:recoverCall → saveCall in main) is a
// call record too, and it is the one a rep most wants labelled, because they
// were not there when it ended. It got nothing — "Call · <date>", no summary,
// no brief, whatever the toggles said (species 58: the new case routed
// through code written for the old one inherits what that path does NOT do).
//
// One function, two callers, so the two paths cannot drift: the same settings
// read at the same moment (AFTER the record exists — BUG-227's lesson, the
// value in force now rather than the one at mount), the same three
// independent fire-and-forgets, the same "one failing never affects the
// others". The AI work itself still happens in main behind the same IPC
// handlers either way; this decides WHETHER to ask, never HOW.
export interface NoteTakerAutoBehaviourHooks {
  /** The brief reached the clipboard (main did the write). */
  onBriefCopied?: () => void
}

/**
 * Fire the opted-in auto-behaviours for a call that was just saved. Resolves
 * once the three requests have been DISPATCHED, not when they finish — a
 * title can take seconds of model time, and nothing that calls this should
 * wait on it. A settings read that fails fires nothing and resolves normally:
 * the call is saved either way, and that is the part that matters.
 */
export async function runNoteTakerAutoBehaviours(
  callId: string,
  hooks: NoteTakerAutoBehaviourHooks = {}
): Promise<void> {
  const noteTaker = await window.api.settings
    .get()
    .then((s) => s.aiNoteTaker)
    .catch(() => null)
  if (noteTaker?.autoSummarize) void window.api.calls.summarizeCall(callId).catch(() => {})
  if (noteTaker?.autoGenerateTitle) void window.api.calls.generateTitle(callId).catch(() => {})
  // §4.6 — the brief lands on the clipboard without anyone clicking. Main
  // does the clipboard write, so this works while the rep is still looking
  // at Zoom and our window has no focus.
  if (noteTaker?.autoPostCallBrief) {
    void window.api.calls
      .postCallBrief(callId)
      .then((res) => {
        if (res.ok && res.copied) hooks.onBriefCopied?.()
      })
      .catch(() => {})
  }
}
