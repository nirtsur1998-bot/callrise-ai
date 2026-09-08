import { takeLegacyAiNoteTakerPrefs } from './prefs'

/**
 * BUG-227's one-time migration, run once per ORIGIN at renderer start.
 *
 * The three AI Note Taker preferences moved from renderer localStorage into
 * the settings file. Moving them alone would have silently switched the
 * feature OFF for everyone who had it on — the same disappearance this
 * migration exists to end, delivered by the fix. So the old keys get read once
 * per origin and folded forward.
 *
 * TWO PROPERTIES CARRY THE WHOLE DESIGN, and both exist because the founder's
 * profile has the same userData reachable from two origins:
 *
 *   1. It only ever turns a preference ON. A seed that could also turn one off
 *      would let whichever app launched first clear the other's settings — a
 *      fresh instance of the bug, shipped as its own remedy.
 *   2. The "already seeded" marker is per-origin (localStorage), not in the
 *      shared settings file. Each origin holds different legacy values and
 *      each needs its own turn. A shared marker would let the first app to
 *      start speak for both, and the packaged app's real settings would never
 *      be read.
 *
 * Nothing is written when there is nothing to turn on, so a fresh install
 * makes no settings write at all.
 *
 * Best-effort throughout: a failure here must never stop the app rendering.
 * The cost of a missed seed is one toggle a user re-flips; the cost of a
 * throw at startup is a black window.
 */
export async function seedAiNoteTakerPrefs(): Promise<void> {
  try {
    const legacy = takeLegacyAiNoteTakerPrefs()
    if (!legacy) return
    // Only the true ones. `false` is indistinguishable from "never set" in the
    // old storage (read() === 'true'), so writing a false would be asserting
    // something the source cannot support — BUG-211's absent-is-not-false rule
    // pointed at the migration rather than at the reader.
    const patch: Record<string, boolean> = {}
    if (legacy.autoSummarize) patch.autoSummarize = true
    if (legacy.autoGenerateTitle) patch.autoGenerateTitle = true
    if (legacy.autoPostCallBrief) patch.autoPostCallBrief = true
    if (Object.keys(patch).length === 0) return
    await window.api.settings.update({ aiNoteTaker: patch })
  } catch {
    /* the marker is already set for this origin; a user re-flips one toggle */
  }
}
