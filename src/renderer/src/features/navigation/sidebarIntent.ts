import { OLD_TO_HUB, type NavId } from './nav-items'

/**
 * What a SIDEBAR click means — BUG-286.
 *
 * Same reasoning as recentTarget.ts next door: the rule is small, it was
 * wrong, and it has a case that is easy to get backwards, so it lives where a
 * test can reach it instead of inside MainApp.
 *
 * THE BUG. `navigateTo` ends in `setActive(hub ?? id)`. Click the sidebar item
 * for the screen you are already on and that sets the SAME value: React bails
 * out, nothing in the subtree unmounts, and the hub's private view state (the
 * open call, the open contact) survives. The page does not change at all —
 * measured on the running app, the whole page-text hash was identical before
 * and after. Every other sidebar item worked, which is what made it look like
 * a Calls bug rather than a rule about navigating to where you already are.
 *
 * THE CASE THAT IS EASY TO GET BACKWARDS is the two navigations. Under the
 * 7-item preview IA, `past-calls` is absorbed INTO the `calls` hub, so
 * clicking "Calls" while a call detail is open is the same-screen case. Under
 * the classic 12-item IA, `past-calls` is its own sidebar item and `calls`
 * does not absorb it — so the same two ids are DIFFERENT screens there.
 * Comparing raw ids gets one IA right and the other wrong.
 */
export type SidebarIntent =
  /** Already here: don't re-navigate (it is a no-op), step out to the list. */
  | { kind: 'step-out' }
  /** A different screen: the ordinary navigation, unchanged. */
  | { kind: 'navigate'; id: NavId }

/** The screen a sidebar id actually lands on, given the IA in force. */
export function sidebarTarget(id: NavId, navPreviewEnabled: boolean): NavId {
  return (navPreviewEnabled ? OLD_TO_HUB[id] : undefined) ?? id
}

export function sidebarIntent(
  id: NavId,
  active: NavId,
  navPreviewEnabled: boolean
): SidebarIntent {
  return sidebarTarget(id, navPreviewEnabled) === active
    ? { kind: 'step-out' }
    : { kind: 'navigate', id }
}
