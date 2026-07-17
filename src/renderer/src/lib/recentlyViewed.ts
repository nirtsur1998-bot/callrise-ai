// Cross-screen "recently viewed" trail — a small localStorage-backed ring
// buffer of the last few calls/contacts/deals opened, so jumping back to one
// doesn't mean re-navigating the whole list. Same simple pattern as every
// other local preference in this app (see features/settings/prefs.ts).

const KEY = 'salesos.recentlyViewed'
const MAX_ITEMS = 8

export type RecentKind = 'call' | 'contact' | 'deal'

export interface RecentItem {
  kind: RecentKind
  id: string
  label: string
  /** ISO timestamp of the most recent visit. */
  viewedAt: string
}

function read(): RecentItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (v): v is RecentItem =>
        v &&
        typeof v === 'object' &&
        typeof v.kind === 'string' &&
        typeof v.id === 'string' &&
        typeof v.label === 'string' &&
        typeof v.viewedAt === 'string'
    )
  } catch {
    return []
  }
}

function write(items: RecentItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items))
  } catch {
    /* localStorage unavailable — just use the in-memory value this session */
  }
}

export function getRecentlyViewed(): RecentItem[] {
  return read()
}

/** Record a visit — moves the item to the front if already present, and caps
 *  the list at MAX_ITEMS (oldest dropped first). Call this from a detail
 *  screen's mount effect. */
export function recordRecentlyViewed(kind: RecentKind, id: string, label: string): void {
  const current = read().filter((item) => !(item.kind === kind && item.id === id))
  const next = [{ kind, id, label, viewedAt: new Date().toISOString() }, ...current].slice(
    0,
    MAX_ITEMS
  )
  write(next)
  notifyChanged()
}

/** Remove one item (e.g. its target was deleted) — keeps the trail honest. */
export function removeRecentlyViewed(kind: RecentKind, id: string): void {
  write(read().filter((item) => !(item.kind === kind && item.id === id)))
  notifyChanged()
}

// A same-window custom event so a display surface (e.g. the sidebar) updates
// live when another part of the app records a new visit — localStorage's own
// 'storage' event only fires in OTHER windows/tabs, never this one. Lives
// here (not useRecentlyViewed.ts) so every writer notifies without needing
// its own import of the hook's event name.
const CHANGE_EVENT = 'salesos:recentlyViewedChanged'

function notifyChanged(): void {
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export { CHANGE_EVENT }
