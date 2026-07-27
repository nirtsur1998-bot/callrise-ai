/**
 * Maps a detected call + the user's capture settings + the consent module's
 * verdict to a concrete capture action. This is the ONLY place that decision
 * gets made - CallDetector calls `decideCaptureAction` and does exactly what
 * it says, nothing more.
 *
 * Hard rule: the consent module is authoritative. This file can only ever
 * degrade 'full' down to 'mic-only' when consent forbids buyer-side
 * recording - it can never loosen or override a consent verdict.
 */

export type CapturePolicyValue = 'full' | 'mic-only' | 'ask'
export type AppOverride = 'full' | 'mic-only' | 'ask' | 'never'

export interface CapturePolicySettings {
  autoCapturePolicy: CapturePolicyValue
  appOverrides: Record<string, AppOverride>
}

/** Result of asking the consent module "is buyer-side recording currently permitted?". */
export interface ConsentVerdict {
  canRecordOtherParty: boolean
}

export type CaptureAction =
  | { type: 'ignore' } // per-app 'never' override
  | { type: 'ask-user' } // show the detection toast; capture only on explicit click
  | { type: 'start'; mode: 'full' | 'mic-only' }

export const DEFAULT_CAPTURE_POLICY_SETTINGS: CapturePolicySettings = {
  autoCapturePolicy: 'mic-only',
  appOverrides: {}
}

/**
 * Pure decision function - no I/O, no Electron APIs. `consent` must reflect
 * the consent module's live verdict for this call/jurisdiction; this
 * function never re-derives or second-guesses it.
 */
export function decideCaptureAction(
  appId: string,
  settings: CapturePolicySettings,
  consent: ConsentVerdict
): CaptureAction {
  const effective = settings.appOverrides[appId] ?? settings.autoCapturePolicy

  if (effective === 'never') return { type: 'ignore' }
  if (effective === 'ask') return { type: 'ask-user' }
  if (effective === 'mic-only') return { type: 'start', mode: 'mic-only' }

  // effective === 'full'
  return consent.canRecordOtherParty
    ? { type: 'start', mode: 'full' }
    : { type: 'start', mode: 'mic-only' }
}
