import { useEffect, useRef } from 'react'

/**
 * BUG-289 — the one-shot-consume prop shape ("open this record, then let the
 * parent clear it so a plain revisit doesn't reopen it") shipped THREE times
 * with a boolean latch instead of an id-keyed one: PastCallsView (M31, fixed
 * there after "the first click worked, and every later one silently did
 * nothing"), then ContactsView and DealsView, then CrmView's own
 * `openDealId`/`openContactId` layer above them — none of which carried
 * M31's fix forward when they were built with the same shape. A boolean
 * latch fires once EVER; it cannot tell "the same record again" from "a
 * different record", so a SECOND RECENT/palette click for a different
 * record — reached while the screen was already active, so nothing
 * remounts it — was silently dropped.
 *
 * This hook is the one place that shape now lives, so there is no fourth.
 * Every consumer gets the same rule: a REPEAT of the same id applies once, a
 * DIFFERENT id always applies, whether or not the component happens to
 * remount in between.
 *
 * Returns a `reset` function: PastCallsView's own BUG-286 step-out handler
 * needs it, because forgetting "which id was last consumed" is what lets the
 * SAME record be reopened from the trail after the rep has stepped out of
 * it — without a reset, this hook's own memory would treat that as a repeat
 * and silently do nothing, the exact failure this hook exists to prevent.
 */
export function useConsumeId(
  id: string | null | undefined,
  onConsume: (id: string) => void
): { reset: () => void } {
  const seenRef = useRef<string | null>(null)
  useEffect(() => {
    if (id && seenRef.current !== id) {
      seenRef.current = id
      onConsume(id)
    }
    // `onConsume` is a fresh closure every render — depending on it would
    // fire this effect on an unrelated re-render (see useStepOutToken's own
    // comment for the same reasoning). The id is the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  return { reset: () => (seenRef.current = null) }
}
