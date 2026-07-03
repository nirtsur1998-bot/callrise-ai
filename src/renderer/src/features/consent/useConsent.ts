import { useCallback, useRef, useState } from 'react'
import type {
  ConsentJurisdiction,
  ConsentMethod,
  ConsentRecord
} from '@renderer/features/calls/types'
import {
  canRecordOtherParty,
  freshConsent,
  loadScript,
  saveDefaultJurisdiction,
  saveScript,
  DEFAULT_SCRIPT
} from './prefs'

const nowIso = (): string => new Date().toISOString()

export interface ConsentController {
  record: ConsentRecord
  /** Always-current mirror of `record`, for the save path (no stale closures). */
  recordRef: { current: ConsentRecord }
  /** True only when the gate is satisfied (status consented + recording on). */
  canRecord: boolean
  /** The editable disclosure script (persisted across calls). */
  script: string
  /** Record a "they said yes" with how consent was obtained. Turns recording ON. */
  markConsented: (method: ConsentMethod) => void
  /** Record a "they said no". Keeps recording OFF. */
  markDeclined: () => void
  /** Turn recording off again without implying they declined. */
  turnOff: () => void
  setJurisdiction: (j: ConsentJurisdiction) => void
  setScript: (s: string) => void
  resetScript: () => void
  /** Back to a fresh, recording-OFF record — used at the start of each call. */
  reset: () => void
}

/**
 * Holds the consent state for the call currently being composed. The only way
 * `recordOtherParty` ever becomes true is `markConsented` — there is no setter
 * that flips it on without recording an explicit consent.
 */
export function useConsent(): ConsentController {
  const [record, setRecord] = useState<ConsentRecord>(() => freshConsent())
  const [script, setScriptState] = useState<string>(() => loadScript())
  const recordRef = useRef<ConsentRecord>(record)

  // Update the ref synchronously alongside state so the save path is never stale.
  const apply = useCallback((next: ConsentRecord) => {
    recordRef.current = next
    setRecord(next)
  }, [])

  const markConsented = useCallback(
    (method: ConsentMethod) => {
      const r = recordRef.current
      apply({
        ...r,
        status: 'consented',
        recordOtherParty: true,
        method,
        disclosedAt: r.disclosedAt ?? nowIso(),
        decidedAt: nowIso()
      })
    },
    [apply]
  )

  const markDeclined = useCallback(() => {
    const r = recordRef.current
    apply({
      ...r,
      status: 'declined',
      recordOtherParty: false,
      disclosedAt: r.disclosedAt ?? nowIso(),
      decidedAt: nowIso()
    })
  }, [apply])

  const turnOff = useCallback(() => {
    apply({ ...recordRef.current, recordOtherParty: false })
  }, [apply])

  const setJurisdiction = useCallback(
    (j: ConsentJurisdiction) => {
      saveDefaultJurisdiction(j) // remember the choice as the new default
      apply({ ...recordRef.current, jurisdiction: j })
    },
    [apply]
  )

  const setScript = useCallback((s: string) => {
    saveScript(s)
    setScriptState(s)
  }, [])

  const resetScript = useCallback(() => {
    saveScript(DEFAULT_SCRIPT)
    setScriptState(DEFAULT_SCRIPT)
  }, [])

  const reset = useCallback(() => {
    apply(freshConsent())
  }, [apply])

  return {
    record,
    recordRef,
    canRecord: canRecordOtherParty(record),
    script,
    markConsented,
    markDeclined,
    turnOff,
    setJurisdiction,
    setScript,
    resetScript,
    reset
  }
}
