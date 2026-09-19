// BUG-285 — once `saveCall` has returned, the Call record exists, and nothing
// that runs after it may turn that into a failed save.
//
// The `calls:save` handler used to run its follow-ups — retiring the journal,
// scheduling the backup, the self-intro name, the cascade jobs — bare, inside
// the same async handler. Any throw there rejected the IPC call although the
// record was already on disk. The renderer swallows a failed save ("the
// transcript is still on screen"), so the rep saw no "saved" notice, the AI
// Note Taker never ran, `onSaved` never fired — and if the throw came before
// the journal was retired, the next launch offered to "recover" a call that
// was saved, which mints a duplicate. BUG-271's shape, in the path every call
// takes.
//
// Two halves, because this wrapper alone only closes the first. Swallowing a
// throw from `endCall` keeps the save reported as saved — but if that throw
// landed before the journal was marked complete, the journal would still be
// offered next launch. So endCall settles the journal in a `finally`
// (live-transcript.ts, end-call-settles-journal.test.ts); this module is the
// half that keeps the IPC result honest.
//
// This is the same discipline as recovery's `cleanupStep`: a follow-up can
// fail; it cannot cost the result. Kept in its own module so it can be
// tested without standing up calls.ts's IPC surface.

/**
 * Run one post-save follow-up. A throw (sync or async) is logged with the
 * step's name and the saved call's id, and swallowed. Awaited by the caller
 * so ORDER is preserved — the self-intro name must land before the contact
 * cascade starts — but never allowed to reject.
 */
export async function postSaveStep(
  name: string,
  callId: string,
  run: () => unknown | Promise<unknown>
): Promise<void> {
  try {
    await run()
  } catch (err) {
    console.error(`[calls] post-save step "${name}" failed (call ${callId} is saved):`, err)
  }
}
