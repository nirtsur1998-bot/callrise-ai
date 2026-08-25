// M29 A1.3 — the IPC surface the Settings page and the Home card use. Only
// 'electron' is stubbed; the handlers drive the real consent/queue code
// against a temp userData directory.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)
  }
}))

const { registerTelemetryIpc } = await import('../ipc')
type TelemetryState = import('../ipc').TelemetryState
const { setupTelemetry } = await import('../setup')
const { record, resetTelemetry } = await import('../index')

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-tel-ipc-'))
  handlers.clear()
  setupTelemetry({ userDataDir: dir, appVersion: '9.9.9', crashDumpsDir: join(dir, 'dumps') })
  registerTelemetryIpc()
})
afterEach(async () => {
  resetTelemetry()
  await rm(dir, { recursive: true, force: true })
})

const call = (channel: string, ...args: unknown[]): unknown => {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn({}, ...args)
}

describe('telemetry IPC', () => {
  it('registers exactly the six channels', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'telemetry:clearQueue',
      'telemetry:clearSent',
      'telemetry:featureOpened',
      'telemetry:flushNow',
      'telemetry:getState',
      'telemetry:setConsent'
    ])
  })

  it('featureOpened validates in MAIN — a renderer cannot invent vocabulary', () => {
    call('telemetry:setConsent', 'on')
    expect(call('telemetry:featureOpened', 'coaching')).toBe(true)
    expect(call('telemetry:featureOpened', 'totally-made-up')).toBe(false)
    expect(call('telemetry:featureOpened', { feature: 'crm' })).toBe(false)
    const state = call('telemetry:getState') as TelemetryState
    const usage = state.queued.filter((e) => e.kind === 'usage')
    expect(usage.map((e) => e.props.feature)).toEqual(['coaching'])
  })

  it('getState before any decision: unasked, no id, empty queue, nothing sent', () => {
    expect(call('telemetry:getState')).toEqual({
      consent: { consent: 'unasked' },
      anonId: null,
      queued: [],
      sent: []
    })
  })

  it("setConsent('on') mints an id and starts the session; the state shows the real queued payload", () => {
    const state = call('telemetry:setConsent', 'on') as TelemetryState
    expect(state.consent.consent).toBe('on')
    expect(state.consent.askedWithVersion).toBe('9.9.9')
    expect(state.anonId).toMatch(/^[0-9a-f-]{36}$/)
    expect(state.queued.map((e) => e.name)).toEqual(['session.start'])
    expect(state.queued[0].props).toEqual({ consentJustGiven: true })
  })

  it('ignores a value that is not on/off, without changing anything', () => {
    const before = call('telemetry:getState')
    for (const junk of ['yes', 'unasked', 1, null, undefined, { consent: 'on' }]) {
      expect(call('telemetry:setConsent', junk)).toEqual(before)
    }
  })

  it("clearQueue empties the queue but keeps consent; setConsent('off') wipes id and queue", () => {
    call('telemetry:setConsent', 'on')
    record('usage', 'feature.rise.opened')
    expect((call('telemetry:getState') as TelemetryState).queued).toHaveLength(2)

    const cleared = call('telemetry:clearQueue') as TelemetryState
    expect(cleared.queued).toEqual([])
    expect(cleared.consent.consent).toBe('on')
    expect(cleared.anonId).not.toBeNull()

    record('usage', 'feature.rise.opened')
    const off = call('telemetry:setConsent', 'off') as TelemetryState
    expect(off).toMatchObject({ consent: { consent: 'off' }, anonId: null, queued: [] })
    expect(record('usage', 'feature.rise.opened').ok).toBe(false)
  })
})
