// M29 A2 — the signal catalog. Each helper is proven to produce exactly its
// event through the real record() pipeline (consent on, temp dir), to
// produce NOTHING with consent off, and to carry no free text — the token
// rule from A1.6 applies to every prop that isn't a number or boolean.
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setConsent } from '../consent'
import { listQueued, resetTelemetry } from '../index'
import { setupTelemetry } from '../setup'
import {
  resetTier1SignalForTests,
  signalFeatureOpened,
  signalAiPurposeFailure,
  signalAiPurposeRecovered,
  signalBackupStepFailed,
  signalConsentFlowError,
  signalJobFinished,
  signalNativeLoad,
  signalRetrievalQuery,
  signalTier1State,
  signalUpdateOutcome
} from '../signals'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-signals-'))
  resetTier1SignalForTests()
  setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: join(dir, 'dumps') })
})
afterEach(async () => {
  resetTelemetry()
  await rm(dir, { recursive: true, force: true })
})

function fireAll(): void {
  signalAiPurposeFailure({
    purpose: 'memory-extract',
    failureClass: 'period-exhausted',
    code: 'rate-limited',
    providerId: 'gemini'
  })
  signalAiPurposeRecovered({ purpose: 'memory-extract', afterConsecutiveFailures: 7 })
  signalJobFinished({ jobType: 'summarize-call', outcome: 'failed', code: 'rate-limited' })
  signalUpdateOutcome({ outcome: 'refused', code: 'not-newer' })
  signalBackupStepFailed({ step: 'salesBrainUpload', code: 'NoSuchBucket' })
  signalNativeLoad({ module: 'onnxruntime', ok: false, errorClass: 'ERR_MOD_NOT_FOUND' })
  signalTier1State({ engineAvailable: true, engineRunning: true, denoisingActive: false })
  signalRetrievalQuery({ resultCount: 0 })
  signalConsentFlowError({ op: 'write', code: 'EACCES' })
  signalFeatureOpened('home')
}

describe('the catalog produces exactly its events (consent on)', () => {
  it('every helper lands one health event with the documented name and props', () => {
    setConsent(dir, 'on')
    fireAll()
    const events = listQueued()
    expect(events.map((e) => [e.kind, e.name])).toEqual([
      ['health', 'ai.purpose.failed'],
      ['health', 'ai.purpose.recovered'],
      ['health', 'job.finished'],
      ['health', 'update.outcome'],
      ['health', 'backup.stepFailed'],
      ['health', 'native.load'],
      ['health', 'tier1.state'],
      ['health', 'retrieval.query'],
      ['health', 'consent.flowError'],
      ['usage', 'feature.opened']
    ])
    const byName = Object.fromEntries(events.map((e) => [e.name, e.props]))
    expect(byName['ai.purpose.failed']).toEqual({
      purpose: 'memory-extract',
      failureClass: 'period-exhausted',
      code: 'rate-limited',
      providerId: 'gemini'
    })
    expect(byName['retrieval.query']).toEqual({ resultCount: 0, zero: true })
    expect(byName['tier1.state']).toEqual({
      engineAvailable: true,
      engineRunning: true,
      denoising: 'false'
    })
    expect(byName['consent.flowError']).toEqual({ op: 'write', code: 'EACCES' })
    // No event carries anything but tokens/numbers/booleans (A1.6's rule).
    for (const e of events) {
      for (const v of Object.values(e.props)) {
        if (typeof v === 'string') expect(v).not.toMatch(/\s/)
      }
    }
  })

  it('tier1.state emits on CHANGE only — a poller cannot flood the queue', () => {
    setConsent(dir, 'on')
    const state = {
      engineAvailable: true,
      engineRunning: true,
      denoisingActive: true as boolean | null
    }
    for (let i = 0; i < 50; i++) signalTier1State(state)
    expect(listQueued()).toHaveLength(1)
    signalTier1State({ ...state, denoisingActive: false }) // the 1.3.0 passthrough shape
    signalTier1State({ ...state, denoisingActive: false })
    expect(listQueued()).toHaveLength(2)
    signalTier1State({ ...state, denoisingActive: null })
    expect(listQueued().at(-1)?.props.denoising).toBe('unknown')
  })

  it('a free-text code is rejected by the event model rather than shipped', () => {
    setConsent(dir, 'on')
    signalJobFinished({
      jobType: 'summarize-call',
      outcome: 'failed',
      code: 'quota exceeded for key sk-ant-please-no'
    })
    // The event never lands — the token rule refuses whitespace. Better no
    // datapoint than a datapoint that might carry provider prose.
    expect(listQueued()).toEqual([])
  })
})

describe('A3 — feature.opened is allowlisted in main', () => {
  it('a real section id records; junk, prose, and invented ids are dropped', () => {
    setConsent(dir, 'on')
    expect(signalFeatureOpened('crm')).toBe(true)
    expect(signalFeatureOpened('live-calls')).toBe(true)
    for (const junk of [
      'not-a-feature',
      'crm; drop table',
      'the user opened crm',
      42,
      null,
      undefined
    ]) {
      expect(signalFeatureOpened(junk)).toBe(false)
    }
    const usage = listQueued().filter((e) => e.kind === 'usage')
    expect(usage.map((e) => e.props.feature)).toEqual(['crm', 'live-calls'])
    expect(usage.every((e) => e.name === 'feature.opened')).toBe(true)
  })
})

describe('consent off — the whole catalog is inert', () => {
  it.each(['unasked', 'off'] as const)(
    'with consent %s, firing every signal writes nothing',
    async (state) => {
      if (state === 'off') setConsent(dir, 'off')
      fireAll()
      expect(listQueued()).toEqual([])
      const files = (await readdir(dir)).sort()
      expect(files).toEqual(state === 'off' ? ['telemetry-consent.json'] : [])
    }
  )
})
