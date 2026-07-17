import { useEffect, useState } from 'react'
import { getRecentlyViewed, CHANGE_EVENT, type RecentItem } from './recentlyViewed'

/** Reactive read of the recently-viewed trail — re-renders whenever any
 *  screen records a new visit via recordRecentlyViewed. */
export function useRecentlyViewed(): RecentItem[] {
  const [items, setItems] = useState<RecentItem[]>(() => getRecentlyViewed())

  useEffect(() => {
    const onChange = (): void => setItems(getRecentlyViewed())
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => window.removeEventListener(CHANGE_EVENT, onChange)
  }, [])

  return items
}
