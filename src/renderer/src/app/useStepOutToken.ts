import { useEffect, useRef } from 'react'

/**
 * BUG-286 — run `stepOut` when the sidebar asks the screen you are already on
 * to go back to its list.
 *
 * MainApp bumps a counter instead of re-navigating, because navigating to the
 * screen you are already on is exactly the no-op this bug is about. A screen
 * with an internal detail view consumes the counter here and drops that view.
 *
 * The rule this hook exists to write once: the FIRST value is not an event.
 * A mount must never step out — the screen may have been opened straight onto
 * a record (a save opening its call, a palette result, a recent row), and
 * treating the initial token as a bump would close it again immediately.
 * Every consumer got this wrong the obvious way, so it lives in one place.
 */
export function useStepOutToken(token: number | undefined, stepOut: () => void): void {
  const seen = useRef(token)
  useEffect(() => {
    if (token === undefined) return
    if (seen.current === token) return
    seen.current = token
    stepOut()
    // `stepOut` is a fresh closure every render; depending on it would fire
    // this effect on unrelated re-renders. The token is the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])
}
