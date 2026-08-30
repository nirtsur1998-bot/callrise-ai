// M31 Slice A — a renderer-local "the events store changed" signal.
//
// Why this exists rather than leaning on the existing `events:changed` IPC
// broadcast: creating an event from the ⌘K palette happens in MainApp, while
// the Calendar screen holds its own separate useCalendar() instance. Both
// ends are already in the SAME renderer process, so a main-process round
// trip is the wrong tool for telling one component about the other's write
// — the same reasoning liveCallNav.ts states verbatim for its own
// cross-component signal ("without an IPC hop since both ends are already in
// the same renderer process").
//
// This does NOT replace the IPC broadcast, which still carries changes that
// genuinely originate in main (a background Google/Outlook sync stamping a
// link). It covers the renderer→renderer case that broadcast was never
// reaching in practice.
//
// A subscriber SET rather than liveCallNav's single-listener slot, because
// more than one useCalendar() can legitimately be mounted at once (the
// Calendar screen and LiveView's meeting matcher both call it).
const listeners = new Set<() => void>()

/** Subscribe to renderer-side event-store changes. Returns an unsubscribe,
 *  matching the shape of the IPC `onChanged` subscription it sits beside. */
export function onEventsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Announce that this renderer just created/updated/deleted an event.
 *  Best-effort and never throws — a missed refresh is a stale view, never a
 *  broken write, and the write itself has already succeeded by this point. */
export function notifyEventsChangedLocally(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* one bad subscriber must not stop the others being told */
    }
  }
}
