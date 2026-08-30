/**
 * ONE switch for the whole M31 redesign.
 *
 * Founder, 2026-08-30: *"Collapse the four previews into one switch. Four
 * toggles for one redesign is itself a discoverability problem, which would
 * be ironic."*
 *
 * It replaces four separate flags that grew one per stage:
 *
 *   salesos.navigation.preview  the 7-item sidebar and the hub screens
 *   salesos.calendar.preview    Week-by-default and the compact connect bar
 *   salesos.identity.preview    First Light — the palette, both themes
 *   salesos.settings.preview    the reworked Settings information architecture
 *
 * ── THE NAMING ─────────────────────────────────────────────────────────────
 *
 * "New design (preview)". Not "Preview features", not "Beta" — the founder's
 * rule was that reading the label should tell you what flipping it does to
 * your app. "Beta" tells you how finished it is, which is a different
 * question and not the one anyone is asking while looking at a switch.
 *
 * ── MIGRATION, AND WHY IT IS CONSERVATIVE ──────────────────────────────────
 *
 * The four old flags did not share a default: navigation and calendar shipped
 * OFF (they change behaviour and muscle memory), identity and settings shipped
 * ON. So "what should the single flag be for someone who already has values
 * stored?" has a real answer rather than an obvious one.
 *
 * The rule here: **an explicit OFF on ANY of the four wins.** If a person
 * deliberately turned something off, collapsing four switches into one must
 * not quietly turn it back on — silently re-enabling something the user
 * rejected is the worst thing a migration can do, and they would have no way
 * to know it happened. Anyone who never touched them, or turned them on, gets
 * the new design.
 *
 * Note this is deliberately NOT "on if any was on". That reading would honour
 * the enthusiastic choice and discard the cautious one; between the two, the
 * cautious one is the one whose owner is harmed by being overruled.
 */

const KEY = 'salesos.design.preview'

/** The flags this replaces, read once for migration and never written. */
const LEGACY_KEYS = [
  'salesos.navigation.preview',
  'salesos.calendar.preview',
  'salesos.identity.preview',
  'salesos.settings.preview'
] as const

export function loadDesignPreview(): boolean {
  try {
    const own = localStorage.getItem(KEY)
    if (own !== null) return own !== 'false'

    // No decision recorded yet for the combined switch. Honour any explicit
    // OFF from the flags it replaces; otherwise default on.
    for (const legacy of LEGACY_KEYS) {
      if (localStorage.getItem(legacy) === 'false') return false
    }
    return true
  } catch {
    return true
  }
}

export function saveDesignPreview(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, String(enabled))
  } catch {
    /* best-effort: a look preference is non-critical */
  }
}

/** Exported for the guard test — a migration rule is worth pinning, since it
 *  runs once per user and a wrong answer is invisible afterwards. */
export const DESIGN_PREVIEW_KEY = KEY
export const LEGACY_PREVIEW_KEYS = LEGACY_KEYS
