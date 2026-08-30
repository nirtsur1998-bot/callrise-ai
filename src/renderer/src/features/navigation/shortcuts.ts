import { isMac } from '@renderer/lib/platform'

/**
 * THE shortcut registry. One list, read by everything that displays a
 * shortcut.
 *
 * Before this there were THREE hand-maintained copies of the same facts:
 *
 *   1. `paletteActions` in MainApp — label + a hand-typed `shortcut` string
 *   2. MainApp's keydown handler — the bindings that actually exist
 *   3. `ShortcutsOverlay.buildGroups()` — a third list, for the `?` sheet
 *
 * They had already drifted, in three separate ways, which is what a third
 * copy always buys:
 *
 *   • The overlay printed the detection shortcuts as `⌘⇧S` / `⌘⇧P` with the
 *     Mac glyph HARDCODED, while main registers them as `CommandOrControl`.
 *     On Windows — the founder's own platform — the sheet named a key that
 *     does not exist. Every other group used the platform-aware variable;
 *     that one group did not.
 *   • Both the palette and the overlay labelled ⌘⇧L "Start a live call".
 *     The handler calls `navigateTo('live-calls')`. It opens the screen; it
 *     starts nothing.
 *   • The overlay listed the detection shortcuts unconditionally, but
 *     `enableOverlayShortcuts()` is called alongside tray presence rather
 *     than at boot — so on a fresh install the sheet advertised hotkeys that
 *     were not registered. (This one was already known: it is in the Stage 0
 *     audit's copy-drift appendix, logged and never fixed.)
 *
 * The registry does not own the key HANDLING — MainApp still owns its
 * keydown listener, and main owns the global ones. What it owns is the
 * single description of what exists, and `shortcuts.test.ts` asserts that
 * description against the real registration sites in both processes, so the
 * two cannot drift again without a red test.
 */

export type ShortcutGroupId =
  | 'navigation'
  | 'palette'
  | 'actions'
  | 'anywhere'
  | 'detection'
  | 'help'

export interface AppShortcut {
  /** Stable id. Palette actions look themselves up by this. */
  id: string
  label: string
  group: ShortcutGroupId
  /** Platform-resolved display string. Never hardcode a ⌘ here. */
  keys: string
  /** Shown only when the preview nav is on, because that is the only time
   *  MainApp registers the digit shortcuts. */
  previewOnly?: boolean
}

/** The modifier, resolved once. The whole ⌘-on-Windows bug was one group
 *  forgetting to use this. */
const MOD = isMac ? '⌘' : 'Ctrl '

export const GROUP_TITLE: Record<ShortcutGroupId, string> = {
  navigation: 'Navigation',
  palette: 'Command palette',
  actions: 'Actions',
  anywhere: 'Anywhere',
  // Accurate rather than flattering: they are registered when call detection
  // is running, not permanently. The old title ("works even when CallRise AI
  // is in the background") implied always-on.
  detection: 'Call detection — while detection is running',
  help: 'Help'
}

export const SHORTCUTS: AppShortcut[] = [
  {
    id: 'palette',
    label: 'Jump to a screen, contact, deal, or call',
    group: 'navigation',
    keys: `${MOD}K`
  },
  {
    id: 'nav-digits',
    label: 'Jump to a section by number (1-7)',
    group: 'navigation',
    keys: `${MOD}1…${MOD}7`,
    previewOnly: true
  },

  { id: 'palette-move', label: 'Navigate results', group: 'palette', keys: '↑↓' },
  { id: 'palette-open', label: 'Open selection', group: 'palette', keys: '↵' },
  { id: 'palette-close', label: 'Close', group: 'palette', keys: 'Esc' },

  {
    id: 'live-call',
    // Says what it does. The handler navigates; it does not start a call, and
    // both the palette and the sheet used to claim otherwise.
    label: 'Go to live calls',
    group: 'actions',
    keys: `${MOD}⇧L`
  },
  { id: 'new-event', label: 'New event', group: 'actions', keys: `${MOD}⇧E` },
  { id: 'toggle-theme', label: 'Toggle theme', group: 'actions', keys: `${MOD}⇧T` },

  { id: 'esc', label: 'Close any dialog', group: 'anywhere', keys: 'Esc' },

  // Registered in MAIN (detection-overlay.ts) as CommandOrControl+Shift+…,
  // which is Ctrl on Windows — hence MOD, not a hardcoded ⌘.
  { id: 'detection-stop', label: 'Stop capturing', group: 'detection', keys: `${MOD}⇧S` },
  {
    id: 'detection-pause',
    label: 'Pause / resume detection',
    group: 'detection',
    keys: `${MOD}⇧P`
  },

  { id: 'help', label: 'Show keyboard shortcuts', group: 'help', keys: '?' }
]

/** The display string for one shortcut, by id. Palette actions use this so a
 *  hint and the sheet can never disagree. Throws rather than returning
 *  undefined: a missing id is a typo, and a silently absent hint is exactly
 *  the invisible-feature problem this milestone exists to fix. */
export function shortcutKeys(id: string): string {
  const found = SHORTCUTS.find((s) => s.id === id)
  if (!found) throw new Error(`unknown shortcut id: ${id}`)
  return found.keys
}

/** The label for one shortcut, by id — so a palette row and the sheet name
 *  the same action the same way. Same throw-on-unknown reasoning as above. */
export function shortcutLabel(id: string): string {
  const found = SHORTCUTS.find((s) => s.id === id)
  if (!found) throw new Error(`unknown shortcut id: ${id}`)
  return found.label
}

/** Grouped for the `?` sheet, in declaration order, with preview-gated rows
 *  dropped when the preview nav is off so the sheet never advertises a
 *  binding that is not registered. */
export function shortcutGroups(
  navPreviewEnabled: boolean
): { id: ShortcutGroupId; title: string; shortcuts: AppShortcut[] }[] {
  const order: ShortcutGroupId[] = [
    'navigation',
    'palette',
    'actions',
    'anywhere',
    'detection',
    'help'
  ]
  return order
    .map((id) => ({
      id,
      title: GROUP_TITLE[id],
      shortcuts: SHORTCUTS.filter(
        (s) => s.group === id && (!s.previewOnly || navPreviewEnabled)
      )
    }))
    .filter((g) => g.shortcuts.length > 0)
}
