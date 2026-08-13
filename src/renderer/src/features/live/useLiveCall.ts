// M26 Phase 4.4 — context + hook only, split from LiveCallProvider.tsx to
// match the codebase's own convention (useToast.ts / ToastProvider.tsx):
// a component file may only export components, or Fast Refresh breaks.
import { createContext, useContext } from 'react'
import type { ConsentController } from '@renderer/features/consent/useConsent'
import type { useTranscription } from './useTranscription'

type UseTranscriptionReturn = ReturnType<typeof useTranscription>

export interface LiveCallContextValue extends UseTranscriptionReturn {
  consent: ConsentController
  /** M19 Task 2 step 5's ref bridge — created in the Provider because it must
   *  be shared between `useLiveCues` (still local to `LiveView`, the writer)
   *  and `useTranscription` (now in the Provider, the reader at save time). */
  buyerIdentityRef: { current: { key: string; name: string } | null }
  /** Register the ACTIVE view's save-completion callback.
   *
   *  `useTranscription`'s own `onSaved` argument is a plain constructor
   *  parameter, evaluated once at the Provider's call site — which now
   *  outlives any one `LiveView` mount. So the Provider hands
   *  `useTranscription` a small stable forwarding function once, and exposes
   *  this setter so whichever `LiveView` instance is currently mounted can
   *  point that forwarder at its own `handleSaved` closure (clips flush,
   *  Deal Intelligence save, the parent's own onSaved prop).
   *
   *  Deliberately never auto-cleared on the calling view's unmount — every
   *  side effect behind it is a plain ref/IPC call with no React state
   *  involved, so calling a "stale" registration after `LiveView` has
   *  navigated away (e.g. a mic-unplug ending the call while the rep is on a
   *  different screen) is harmless and correct: it is still the same call,
   *  and the last-registered handler is exactly the one whose closure knows
   *  about that call's clips and Deal Intelligence report. Clearing it would
   *  only make that one case silently skip work that should still happen. */
  setOnSaved: (cb: ((callId: string) => void) | null) => void
}

export const LiveCallContext = createContext<LiveCallContextValue | null>(null)

/** Read the live call in progress. Must be called from inside
 *  `LiveCallProvider` (mounted once in App.tsx, wrapping `MainApp`). */
export function useLiveCall(): LiveCallContextValue {
  const value = useContext(LiveCallContext)
  if (!value) {
    throw new Error('useLiveCall() called outside LiveCallProvider')
  }
  return value
}
