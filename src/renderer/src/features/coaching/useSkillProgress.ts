import { useEffect, useRef, useState } from 'react'
import type { FocusSkillState, SkillProgress } from './types'

export interface UseSkillProgress {
  progress: SkillProgress[]
  focusSkill: FocusSkillState | null
  loading: boolean
}

/** M23 — reads the main process's Skill Graph rollup (window.api.coach2),
 *  computed from every coached call's stored skills. Refetches once on
 *  mount; callers that need "just coached, show the new numbers" reload
 *  should remount this hook (e.g. by key-ing on callId) rather than adding
 *  a live-subscription channel this feature doesn't need yet.
 *
 *  `enabled` (default true) skips the IPC round-trips entirely — pass
 *  `false` from a caller that mounts unconditionally (e.g. CoachReportView,
 *  rendered for every coached call including pre-M23 ones) but only needs
 *  this data in a specific case, so opening a report never triggers a full
 *  calls-directory scan+parse on the main process for reps who never turned
 *  Coach 2.0 on. The hook itself still runs every render (Rules of Hooks) —
 *  only the actual disk/IPC work is conditional. */
export function useSkillProgress(enabled = true): UseSkillProgress {
  const [progress, setProgress] = useState<SkillProgress[]>([])
  const [focusSkill, setFocusSkill] = useState<FocusSkillState | null>(null)
  const [loading, setLoading] = useState(enabled)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    void (async () => {
      try {
        const [p, f] = await Promise.all([
          window.api.coach2.getProgress(),
          window.api.coach2.getFocusSkill()
        ])
        if (!mountedRef.current) return
        setProgress(p)
        setFocusSkill(f)
      } catch {
        /* empty dashboard is fine — this is read-only, best-effort */
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    })()
  }, [enabled])

  return { progress, focusSkill, loading }
}
