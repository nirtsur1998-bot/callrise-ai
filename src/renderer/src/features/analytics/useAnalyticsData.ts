import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoachDimensionKey } from '@renderer/features/coaching/types'
import { computeAnalytics, type Analytics, type CoachedCall } from './aggregate'

interface UseAnalyticsData {
  analytics: Analytics | null
  loading: boolean
}

/**
 * Reads the same on-disk data the other screens use (calls + coaching + tasks)
 * via the existing IPC, then aggregates it locally. Read-only: it never writes,
 * scores, or calls a live service.
 */
export function useAnalyticsData(): UseAnalyticsData {
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [loading, setLoading] = useState(true)
  // Guards a load left running past this hook's own effect lifetime, not just
  // the mount effect below — a background restore can trigger a SECOND load
  // while the first is still in flight, and the first's result must not land
  // after the second's (older data overwriting newer).
  const generationRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current
    try {
      const [calls, tasks] = await Promise.all([window.api.calls.list(), window.api.tasks.list()])

      // The list summaries lack dimension scores + talk ratio, so fetch the
      // full record for coached calls only (same pattern as the Coaching screen).
      const coachedCalls = await Promise.all(
        calls.filter((c) => c.hasCoaching).map((c) => window.api.calls.get(c.id))
      )

      const coached: CoachedCall[] = []
      for (const call of coachedCalls) {
        if (!call?.coaching) continue
        const scores: Partial<Record<CoachDimensionKey, number>> = {}
        for (const d of call.coaching.dimensions) scores[d.key] = d.score
        coached.push({
          id: call.id,
          createdAt: call.createdAt,
          overallScore: call.coaching.overallScore,
          talkRatio: call.coaching.metrics.talkRatio,
          scores
        })
      }

      if (generation !== generationRef.current) return
      setAnalytics(computeAnalytics({ calls, coached, tasks }))
    } catch {
      if (generation === generationRef.current) setAnalytics(null)
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time data fetch; state set only after the await, same pattern as useCalls.ts's refresh()
    void load()
  }, [load])

  useEffect(() => {
    // A cloud restore can bring back call/task/coaching data in the
    // background (same signal useCalls.ts/useTasks.ts/useDeals.ts already
    // act on) — without this, Analytics only reflected it after the rep
    // navigated away and back, while the Pipeline Forecast card on the same
    // screen (backed by useDeals) updated live, an inconsistency a rep could
    // actually notice mid-screen.
    return window.api.backup.onChanged(() => void load())
  }, [load])

  return { analytics, loading }
}
