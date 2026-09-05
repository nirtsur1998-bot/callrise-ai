import type { RecentItem } from '@renderer/lib/recentlyViewed'
import type { NavId } from './nav-items'

/**
 * Where a recent-trail row actually goes.
 *
 * This exists as a pure function, separate from MainApp, for the reason
 * BUG-140 forces: component render output cannot be tested in this repo, so
 * CORRECTION 2026-09-05: components CAN be render-tested here — see live-header-pieces.render.test.ts (`@vitest-environment happy-dom`, react-dom/client, a `.test.ts` file). The pure/UI split below still stands on its own merits; it is no longer forced.
 * anything with a rule in it lives where a test can reach it. The rule here
 * is small and was wrong for a long time, which is exactly the kind that
 * earns its own module.
 *
 * THE BUG THIS REPLACES. The sidebar used a `Record<RecentKind, NavId>` —
 * destination derived from the item's CATEGORY. Every call row produced the
 * same destination, every contact row produced the same destination, and each
 * item's `id` — carried on every RecentItem since the feature shipped — was
 * never read. Clicking "Ben — Super Fund Trading Pitch" opened a calls screen,
 * not Ben's call. Founder: "a link that goes somewhere plausible but wrong,
 * which is worse than a dead link."
 *
 * The shape of the fix is that the return value CANNOT be produced without
 * the item: `id` comes straight off it. A category-keyed table cannot express
 * this signature, which is the point.
 */
export interface RecentTarget {
  /** The screen that owns this record type. MainApp maps it through
   *  OLD_TO_HUB when the preview IA is on, exactly as any other navigation. */
  nav: NavId
  /** Which one-shot preselect slot the id belongs in. Named for the record
   *  type rather than the screen, because two of them share a screen. */
  slot: 'call' | 'contact' | 'deal'
  /** The record to open. The whole reason this function takes an item. */
  id: string
}

export function recentTarget(item: RecentItem): RecentTarget {
  switch (item.kind) {
    case 'call':
      return { nav: 'past-calls', slot: 'call', id: item.id }
    case 'contact':
      return { nav: 'crm', slot: 'contact', id: item.id }
    case 'deal':
      return { nav: 'crm', slot: 'deal', id: item.id }
  }
}
