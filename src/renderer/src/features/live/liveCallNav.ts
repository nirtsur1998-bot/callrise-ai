// M26 Phase 4.6 — the live-call pill (App.tsx, a sibling of MainApp, same
// reason as ActivityCenter/InterruptedCallPrompt: it must survive MainApp's
// swap to a wholly separate tree for Settings) needs to jump MainApp back to
// the Live Calls screen on click. MainApp owns `active`/`setActive` as plain
// local state, not lifted into any context — the same shape
// window.api.app.onCallDetected already uses to make MainApp jump to Live
// Calls from an external trigger (there: main process; here: a sibling
// component), just without an IPC hop since both ends are already in the
// same renderer process. A single listener slot, not a generic event bus:
// this exists for exactly one signal, and adding generality nothing calls
// yet would be speculative.
let listener: (() => void) | null = null

/** Called once by MainApp, in an effect, mirroring how it subscribes to
 *  onCallDetected. */
export function setGoToLiveCallsListener(fn: (() => void) | null): void {
  listener = fn
}

/** Called by the live-call pill (or anything else that ever needs the same
 *  "take me back to the call" action) on click. A no-op if MainApp isn't
 *  mounted to listen — never throws, same posture as every other
 *  best-effort UI signal in this codebase. */
export function goToLiveCalls(): void {
  listener?.()
}
