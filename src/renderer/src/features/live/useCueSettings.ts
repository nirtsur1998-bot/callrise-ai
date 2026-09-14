import { useCallback, useEffect, useRef, useState } from 'react'
import type { Sensitivity } from './useLiveCues'

// M26 Phase 4.5.2 — moved from renderer-only localStorage
// (salesos.cues.enabled/sensitivity) to main's AppSettings (app-settings.ts's
// liveCues field), so main can read this once the cue engine itself moves
// into main (4.5.4) — main cannot gate its own cadence on a value that only
// ever existed inside a React hook. External shape is unchanged; every call
// site (LiveCallProvider, CopilotPanel, CoachingSection) keeps working as-is.
//
// Each hook instance loads once from main on mount and writes back through
// IPC on every setter call.
//
// BUG-270 — CROSS-INSTANCE SYNC, added when it became user-visible. Until
// this, instances did not see each other's writes (localStorage's own
// behaviour in one window, carried over). With three instances alive at once
// — the Provider's, the Voice AI panel's, the Settings page's — a switch
// flipped in one place kept showing its old state everywhere else. That was
// tolerable for the mute; it is not for a consent-class switch: driven on
// 2026-09-14, "Turn off" on the Live banner wrote `clientContext: false` to
// disk while the panel's switch stayed ON, and a rep reading the panel would
// have believed their buyer's words were still being sent — or, worse, the
// reverse. So every setter now publishes to every live instance. Each
// instance still loads from main on mount (so a fresh mount cannot show a
// stale module value from a previous session), and each publishes what it
// loaded, which also converges instances that mounted before the load landed.

export interface CueSettings {
  enabled: boolean
  setEnabled: (v: boolean) => void
  sensitivity: Sensitivity
  setSensitivity: (s: Sensitivity) => void
  /** M34 3c — the live screen's Quiet mode (hides the between-turn
   *  instruments). Persisted beside the cue settings; see app-settings.ts. */
  quiet: boolean
  setQuiet: (v: boolean) => void
  /** BUG-270 — "Use what this client told you before": whether a calendar-
   *  matched contact's dossier (their earlier words) is sent to the AI
   *  provider with the transcript. Main gates on its own copy of this value;
   *  this mirror is for the panel and the Live banner. Default ON (founder,
   *  2026-09-14) — the switch exists so a rep can SEE it and STOP it. */
  clientContext: boolean
  setClientContext: (v: boolean) => void
}

interface CueState {
  enabled: boolean
  sensitivity: Sensitivity
  quiet: boolean
  clientContext: boolean
}

// Same defaults main's own sanitizeLiveCues() falls back to — shown until
// the real value has loaded.
const DEFAULTS: CueState = {
  enabled: true, // default ON
  sensitivity: 'low', // default calm
  quiet: false, // default: today's screen
  clientContext: true // BUG-270 — default ON, founder decision
}

// The publish/subscribe seam between instances. Module-level on purpose: the
// instances live in different subtrees (Provider, panel, Settings page) with
// no shared ancestor that owns this state.
const listeners = new Set<(patch: Partial<CueState>) => void>()
function publish(patch: Partial<CueState>): void {
  for (const l of listeners) l(patch)
}

export function useCueSettings(): CueSettings {
  const [state, setState] = useState<CueState>(DEFAULTS)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    const onPatch = (patch: Partial<CueState>): void => {
      if (mountedRef.current) setState((s) => ({ ...s, ...patch }))
    }
    listeners.add(onPatch)
    window.api.settings
      .get()
      .then((s) => {
        if (!mountedRef.current) return
        // Published rather than set locally, so an instance that mounted
        // earlier and is still on its defaults converges on the same value.
        publish({
          enabled: s.liveCues.enabled,
          sensitivity: s.liveCues.sensitivity,
          quiet: s.liveCues.quiet === true,
          clientContext: s.liveCues.clientContext !== false
        })
      })
      .catch(() => {
        /* keep the defaults shown above */
      })
    return () => {
      mountedRef.current = false
      listeners.delete(onPatch)
    }
  }, [])

  // Each setter writes ITS OWN patch through IPC — never the whole shape — so
  // a quiet toggle cannot clobber a mute set a second earlier elsewhere.
  const setEnabled = useCallback((v: boolean) => {
    publish({ enabled: v })
    void window.api.settings.update({ liveCues: { enabled: v } })
  }, [])

  const setSensitivity = useCallback((s: Sensitivity) => {
    publish({ sensitivity: s })
    void window.api.settings.update({ liveCues: { sensitivity: s } })
  }, [])

  const setQuiet = useCallback((v: boolean) => {
    publish({ quiet: v })
    void window.api.settings.update({ liveCues: { quiet: v } })
  }, [])

  const setClientContext = useCallback((v: boolean) => {
    publish({ clientContext: v })
    void window.api.settings.update({ liveCues: { clientContext: v } })
  }, [])

  return {
    enabled: state.enabled,
    setEnabled,
    sensitivity: state.sensitivity,
    setSensitivity,
    quiet: state.quiet,
    setQuiet,
    clientContext: state.clientContext,
    setClientContext
  }
}
