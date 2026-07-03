import { useEffect, useState } from 'react'
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

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
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

        if (cancelled) return
        setAnalytics(computeAnalytics({ calls, coached, tasks }))
      } catch {
        if (!cancelled) setAnalytics(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  return { analytics, loading }
}
