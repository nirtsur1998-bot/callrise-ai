import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { SpeakerTranscript } from '@renderer/components/SpeakerTranscript'
import type { CallSegment } from '@renderer/features/calls/types'
import type { SpeakerIdentities } from '@renderer/features/coaching/meta'

interface TranscriptViewProps {
  segments: CallSegment[]
  interimText: string
  repSpeaker?: number | null
  /** Session is paused — swaps the empty-state copy + dots for a "Paused" one. */
  paused?: boolean
  /** M19 Task 2 step 5 — the buyer's name, once self-intro extraction has
   *  resolved it live. No calendar/contact resolution here (that needs a
   *  saved callId) — self-intro is the only source that can name someone
   *  DURING a call in progress. */
  identities?: SpeakerIdentities
  /** BUG-158 — pixels to keep clear at the top so the floating Deal
   *  Intelligence panel never sits on top of transcript text. 0 when that
   *  panel is not mounted, which is the common case. */
  reservedTopPx?: number
}

/** Scrollable live transcript: speaker-labeled finalized turns + faint interim. */
export function TranscriptView({
  segments,
  interimText,
  repSpeaker = null,
  paused = false,
  identities,
  reservedTopPx = 0
}: TranscriptViewProps): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  // Mirrors stickToBottom into render state — only to decide whether the
  // "jump to latest" affordance shows, so it doesn't need to fire on every
  // scroll pixel the way the ref-based auto-scroll check does.
  const [caughtUp, setCaughtUp] = useState(true)
  /** BUG-161 — is THIS box the element that scrolls?
   *
   *  The jump affordance below is `absolute bottom-4` inside this box, which
   *  is only meaningful when the box is the scroller. When the page scrolls
   *  instead (the live-call case — see followTarget), this box grows with its
   *  content and "bottom" lands at the bottom of a very tall element. Measured
   *  on a real call: the control rendered at y=1851 in an 816px viewport —
   *  present, correct-looking in the DOM, and completely unreachable at the
   *  exact moment the reader wanted it.
   *
   *  AppShell already provides the working affordance for that case (its
   *  ScrollToEnd chevron, measured on screen at y=762 during the same call),
   *  so the honest thing is to offer ONE reachable control rather than two,
   *  one of which is invisible. */
  const [ownsScroller, setOwnsScroller] = useState(false)

  /** BUG-161 — FOLLOW THE CONVERSATION.
   *
   *  The element that actually scrolls during a live call is NOT this
   *  component's own box. LiveView is deliberately not full-bleed (see
   *  CallsHub's header comment: "LiveView is NOT fullBleed"), so it renders
   *  inside AppShell's padded, SCROLLING content column — and this box simply
   *  grows with its content. Measured on a real call: scrollHeight and
   *  clientHeight were identical at 2804 = 2804, so `overflow-y: auto` never
   *  engaged and the effect below had nothing to move. The page grew instead,
   *  and the rep had to chase the newest line by hand for the whole call.
   *  Fifty hours of use, no working auto-scroll.
   *
   *  So resolve the scroller at runtime instead of assuming it: walk up from
   *  this box and take the first ancestor that genuinely overflows. That is
   *  this element when the layout bounds it, and AppShell's column when it does
   *  not — correct either way, and it does not require making the live screen
   *  full-bleed, which would strip its padding and change a layout the founder
   *  has been using.
   *
   *  Falls back to this element so behaviour is unchanged wherever the
   *  transcript IS bounded (a narrower window, a future full-bleed live view). */
  const followTarget = (): HTMLElement | null => {
    let el: HTMLElement | null = scrollRef.current
    while (el) {
      const style = getComputedStyle(el)
      const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll'
      if (scrolls && el.scrollHeight > el.clientHeight + 4) return el
      el = el.parentElement
    }
    return scrollRef.current
  }

  // useLAYOUTEffect, not useEffect, and the difference is measurable.
  //
  // A plain effect runs after paint, so scrollHeight can still be the value
  // from BEFORE the new lines were laid out — the view then scrolls to the old
  // bottom and sits behind the newest line until the next turn nudges it.
  // Caught on a driven call: one turn landed at scrollTop 621 of a 856 max,
  // 235px short, with the newest line off screen, and the following turn
  // corrected it. Intermittent by nature, which is exactly why it survived.
  //
  // useLayoutEffect runs after the DOM mutation and BEFORE paint, so the height
  // it reads is the one the user is about to see. The scroll is applied in the
  // same frame, so there is no visible jump either.
  useLayoutEffect(() => {
    const el = followTarget()
    if (el && stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [segments, interimText])

  /** Re-pin whenever the CONTENT changes height, not only when React re-renders.
   *
   *  The effect above fires on [segments, interimText], which is not the same
   *  thing as "the transcript got taller". A line can grow after its state
   *  update — text wrapping to a second line, a speaker label resolving, the
   *  Deal Intelligence panel changing the reserved inset — and none of that
   *  produces a new segments array to depend on.
   *
   *  Measured twice on driven calls: one turn landed 235px short of the bottom
   *  with the newest line off screen, and STAYED there past a 1.3s poll, so it
   *  was not a sub-frame race that useLayoutEffect alone could fix. It caught
   *  up only when the next turn happened to re-render.
   *
   *  Observing the content element closes that gap: any height change re-pins
   *  while the reader is following, and never while they have scrolled away —
   *  stickToBottom is still the single authority on that. */
  useEffect(() => {
    const content = scrollRef.current
    if (!content) return
    const repin = (): void => {
      const el = followTarget()
      if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
    }
    const ro = new ResizeObserver(repin)
    ro.observe(content)
    if (content.firstElementChild) ro.observe(content.firstElementChild)
    // ALSO observe the scroller's own content. The transcript is not the only
    // thing that changes this column's height: Live Deal Intelligence appears
    // mid-call above it and pushes everything down without the transcript box
    // itself resizing at all. Measured — the follow failed at exactly the turn
    // that panel showed up, 235px short, reproducibly, at lines=10 in three
    // separate runs.
    const target = followTarget()
    if (target && target !== content) {
      ro.observe(target)
      for (const child of Array.from(target.children)) ro.observe(child)
    }
    // A deferred second pass for layout that settles after the observer fires
    // (fonts, wrapping, a panel animating in). Cheap, bounded, and it only ever
    // re-applies the same pin the user already asked for by staying at the
    // bottom.
    const settle = setTimeout(repin, 250)
    return () => {
      clearTimeout(settle)
      ro.disconnect()
    }
  }, [segments.length])

  /** The scroll listener has to live on the element that ACTUALLY scrolls.
   *  The JSX binds onScroll to the inner box, which is the right place only
   *  when that box is the scroller — and during a live call it is not, so
   *  "the reader scrolled away" would never fire and the view would follow the
   *  transcript even while someone was reading back through it.
   *
   *  Re-resolved whenever the transcript grows, because which ancestor
   *  overflows can change mid-call (the window resizes, the copilot panel
   *  collapses, Deal Intelligence appears and takes height). */
  useEffect(() => {
    const el = followTarget()
    setOwnsScroller(el === scrollRef.current)
    if (!el || el === scrollRef.current) return // the JSX onScroll already covers it
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [segments.length])

  const handleScroll = (): void => {
    // Judge the same element the effect moves, or "has the reader scrolled
    // away?" is answered about a box that never scrolls and always reads true.
    const el = followTarget()
    if (!el) return
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stickToBottom.current = stuck
    setCaughtUp((prev) => (prev === stuck ? prev : stuck))
  }

  const jumpToLatest = (): void => {
    const el = followTarget()
    if (!el) return
    stickToBottom.current = true
    setCaughtUp(true)
    el.scrollTop = el.scrollHeight
  }

  const isEmpty = segments.length === 0 && !interimText

  return (
    // BUG-161 — `min-h-0` is what makes the live transcript scroll AT ALL, and
    // its absence is why auto-scroll never worked in 50+ hours of real use.
    //
    // A flex item defaults to `min-height: auto`, which refuses to shrink below
    // its content. Without min-h-0 this box grew with every new line, the inner
    // `h-full overflow-y-auto` grew with it, and scrollHeight stayed exactly
    // equal to clientHeight — measured live at 2441 = 2441. `overflow-y: auto`
    // therefore never engaged: there was no internal overflow to scroll, so the
    // stickToBottom effect below had nothing to move and the whole PAGE grew
    // instead. The rep had to chase the newest line by hand.
    //
    // LiveView's own wrapper already carries min-h-0 for exactly this reason
    // (see the `relative flex min-h-0 flex-1 flex-col` around this component);
    // the chain was broken at this one link.
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      // BUG-161 — the Deal Intelligence reservation lives on the VIEWPORT, not
      // on the scrolling content.
      //
      // BUG-158 put it on the scroller as padding-top, which was correct while
      // nothing scrolled: the transcript could not move, so a padded first line
      // stayed clear of the floating panel forever. Now that the transcript
      // actually scrolls (min-h-0 above), padding scrolls away with the content
      // and every line after the first slides straight back under the panel.
      //
      // Padding the PARENT shrinks the scroll viewport instead, so the panel
      // occupies space the transcript can never occupy — at any scroll offset,
      // for the whole call. It also answers the founder's question directly:
      // auto-scroll cannot hide Deal Intelligence, because the panel is pinned
      // to this box's top edge and the transcript now scrolls entirely beneath
      // it rather than through it.
      style={reservedTopPx > 0 ? { paddingTop: reservedTopPx } : undefined}
    >
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto rounded-2xl border border-line-soft bg-surface px-7 py-6"
      >
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5">
            <p className="text-sm text-faint">
              {paused
                ? 'Paused — nothing is being captured'
                : 'Your words will appear here as you speak…'}
            </p>
            {!paused && (
              <div className="flex items-center gap-1.5" aria-hidden="true">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                  style={{ animationDelay: '150ms' }}
                />
                <span
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                  style={{ animationDelay: '300ms' }}
                />
              </div>
            )}
          </div>
        ) : (
          <SpeakerTranscript
            segments={segments}
            interimText={interimText}
            repSpeaker={repSpeaker}
            identities={identities}
          />
        )}
      </div>
      {!caughtUp && !isEmpty && ownsScroller && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="no-drag press absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-elevated px-3 py-1.5 text-xs font-medium text-ink shadow-md transition hover:brightness-110"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Jump to latest
        </button>
      )}
    </div>
  )
}
