import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  FocusSkillAtCoaching,
  PrepBriefEventInput,
  PrepBriefRecord
} from '../../../../preload/index.d'

interface UsePrepBrief {
  loading: boolean
  record: PrepBriefRecord | null
  error: string | null
  /** M23 A4 — the current Focus Skill, when Coach 2.0 is on. Always the
   *  LIVE current focus, even when `record` came back from cache. */
  focusSkillReminder: FocusSkillAtCoaching | null
  regenerate: () => Promise<void>
}

/** Fetches (and caches server-side via content-hash, see prep-brief-fs.ts) the
 *  prep brief for one calendar event. `input` should be stable across
 *  re-renders (memoize at the call site) — a new object identity on every
 *  render would refire the effect, though not re-bill the AI call since main
 *  itself is the one actually caching by content hash, not this hook. */
export function usePrepBrief(input: PrepBriefEventInput | null): UsePrepBrief {
  const [loading, setLoading] = useState(false)
  const [record, setRecord] = useState<PrepBriefRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focusSkillReminder, setFocusSkillReminder] = useState<FocusSkillAtCoaching | null>(null)
  // Guards a stale response from an abandoned fetch (input changed, or the
  // modal closed) from clobbering a newer one that resolved first.
  const requestIdRef = useRef(0)

  const load = useCallback(
    async (force: boolean) => {
      if (!input) return
      const requestId = ++requestIdRef.current
      setLoading(true)
      setError(null)
      const result = force
        ? await window.api.prepBrief.regenerate(input)
        : await window.api.prepBrief.getForEvent(input)
      if (requestIdRef.current !== requestId) return // superseded
      setLoading(false)
      if (result.ok) {
        setRecord(result.record)
        setFocusSkillReminder(result.focusSkillReminder ?? null)
      } else {
        setRecord(null)
        setFocusSkillReminder(null)
        setError(
          result.error === 'no-key'
            ? 'Add an AI provider key in Settings to generate prep briefs.'
            : result.error === 'no-context'
              ? 'Nothing on record for this meeting yet — link a contact or add notes to their profile.'
              : (result.message ?? 'Could not generate the prep brief.')
        )
      }
    },
    [input]
  )

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching on mount/eventId-change, same pattern as useCalendar's refresh()
    void load(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on input's eventId, not its identity
  }, [input?.eventId])

  return { loading, record, error, focusSkillReminder, regenerate: () => load(true) }
}
