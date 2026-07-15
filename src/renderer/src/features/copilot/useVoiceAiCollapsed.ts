import { useCallback, useState } from 'react'
import { getVoiceAiCollapsed, setVoiceAiCollapsed } from './prefs'

/** Collapsed/expanded state for the right-hand Voice AI panel. Lifted up to
 *  MainApp (rather than owned inside the panel) so AppShell can also read it
 *  and actually narrow the column — not just hide content inside a fixed width. */
export function useVoiceAiCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(() => getVoiceAiCollapsed())

  const setCollapsed = useCallback((v: boolean) => {
    setVoiceAiCollapsed(v)
    setCollapsedState(v)
  }, [])

  return [collapsed, setCollapsed]
}
