// M29 A1.3 — the renderer's window onto telemetry: the consent state, the
// anonymous id (so the user can see exactly what identifies them), the
// queue (the actual events waiting to go), and the controls. Electron lives
// only here; the logic is in setup.ts / consent.ts / index.ts.

import { ipcMain } from 'electron'
import { readAnonId } from './anon-id'
import type { ConsentRecord } from './consent'
import { clearQueued, listQueued, type TelemetryEvent } from './index'
import { applyConsentDecision, currentConsent, getTelemetrySetup } from './setup'
import { signalFeatureOpened } from './signals'
import { flushTelemetry, type FlushResult } from './flush'
import { clearSent, listSentRows } from './sent-log'
import type { IngestRow } from './transport'

export interface TelemetryState {
  consent: ConsentRecord
  /** null until the user opts in; deleted when they opt out. */
  anonId: string | null
  /** Waiting to be sent — the real payloads, oldest first. */
  queued: TelemetryEvent[]
  /** Already sent — the exact rows from the sent log, newest batch first. */
  sent: IngestRow[]
}

export function getTelemetryState(): TelemetryState {
  const setup = getTelemetrySetup()
  return {
    consent: currentConsent(),
    anonId: setup ? readAnonId(setup.userDataDir) : null,
    queued: listQueued(),
    sent: setup ? listSentRows(setup.userDataDir) : []
  }
}

export function registerTelemetryIpc(): void {
  ipcMain.handle('telemetry:getState', (): TelemetryState => getTelemetryState())
  ipcMain.handle('telemetry:setConsent', (_event, value: unknown): TelemetryState => {
    if (value === 'on' || value === 'off') applyConsentDecision(value)
    return getTelemetryState()
  })
  ipcMain.handle('telemetry:clearQueue', (): TelemetryState => {
    clearQueued()
    return getTelemetryState()
  })
  ipcMain.handle('telemetry:clearSent', (): TelemetryState => {
    const setup = getTelemetrySetup()
    if (setup) clearSent(setup.userDataDir)
    return getTelemetryState()
  })
  // A3 — the renderer reports which section opened; the allowlist lives in
  // main (signals.ts), so junk ids are dropped, never recorded.
  ipcMain.handle('telemetry:featureOpened', (_event, feature: unknown): boolean => {
    return signalFeatureOpened(feature)
  })
  // "Send now" — lets the user (and the verification pass) watch a batch go
  // and then read it back from the sent log. Same path the schedule uses.
  ipcMain.handle(
    'telemetry:flushNow',
    async (): Promise<{ result: FlushResult; state: TelemetryState }> => {
      const result = await flushTelemetry()
      return { result, state: getTelemetryState() }
    }
  )
}
