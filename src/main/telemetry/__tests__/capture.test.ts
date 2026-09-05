// M29 A1.2 — capture. The headline claim: an error whose MESSAGE carries
// content (a transcript line, a contact name) produces an event that carries
// the class and the frames and NOT the message. Controls prove the raw error
// had the content; red-check = keep the message line in stackFrames().
import { mkdtemp, readdir, rm, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  captureChildGone,
  captureError,
  captureRendererGone,
  errorClassOf,
  errorCodeOf,
  errorEventProps,
  stackFrames
} from '../capture'
import { configureTelemetry, listQueued, resetTelemetry } from '../index'
import { checkNativeCrashes } from '../native-crashes'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-capture-'))
})
afterEach(async () => {
  resetTelemetry()
  await rm(dir, { recursive: true, force: true })
})

const TRANSCRIPT = 'Buyer said: our budget is forty thousand and the CFO is Dana'

function plantedError(): Error {
  const err = new TypeError(`Cannot summarize — ${TRANSCRIPT}`)
  err.stack = [
    `TypeError: Cannot summarize — ${TRANSCRIPT}`,
    '    at summarize (C:\\Users\\danawhitfield\\AppData\\Local\\Programs\\CallRiseAI\\resources\\app.asar\\out\\main\\index.js:10:5)',
    '    at async run (C:\\Users\\danawhitfield\\AppData\\Local\\Programs\\CallRiseAI\\resources\\app.asar\\out\\main\\index.js:99:1)'
  ].join('\n')
  return err
}

describe('what an error event carries', () => {
  it('keeps the class and the frames, drops the message line', () => {
    const err = plantedError()
    expect(err.stack).toContain(TRANSCRIPT) // control
    const props = errorEventProps('main:uncaughtException', err)
    expect(props.errorClass).toBe('TypeError')
    expect(props.scope).toBe('main:uncaughtException')
    expect(String(props.stack)).not.toContain(TRANSCRIPT)
    expect(String(props.stack)).not.toContain('Cannot summarize')
    expect(String(props.stack)).toContain('at summarize (')
    expect(String(props.stack).split('\n')).toHaveLength(2)
    expect(Object.keys(props).sort()).toEqual(['errorClass', 'scope', 'stack']) // no message key exists
  })

  it('stackFrames keeps only `at …` lines and caps them', () => {
    const many = [
      'Error: msg',
      ...Array.from({ length: 50 }, (_, i) => `    at f${i} (x.js:${i}:1)`)
    ].join('\n')
    const frames = stackFrames(many).split('\n')
    expect(frames).toHaveLength(30)
    expect(frames[0]).toBe('    at f0 (x.js:0:1)')
    expect(stackFrames(undefined)).toBe('')
    expect(stackFrames('just a message, no frames')).toBe('')
  })

  it('errorClassOf reads a class from a renderer-forwarded string but never the message', () => {
    expect(errorClassOf(new RangeError('x'))).toBe('RangeError')
    expect(
      errorClassOf('TypeError: Cannot read properties of undefined\n    at a (b.js:1:1)')
    ).toBe('TypeError')
    expect(errorClassOf('just text')).toBe('string')
    expect(errorClassOf(null)).toBe('null')
    expect(errorClassOf({ code: 'ENOENT' })).toBe('object')
  })

  it('errorCodeOf keeps short identifiers only', () => {
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT')
    expect(
      errorCodeOf(Object.assign(new Error('x'), { code: 'ERR_UPDATER_INVALID_VERSION' }))
    ).toBe('ERR_UPDATER_INVALID_VERSION')
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 7 }))).toBe('7')
    expect(
      errorCodeOf(Object.assign(new Error('x'), { code: `prose with ${TRANSCRIPT}` }))
    ).toBeUndefined()
    expect(errorCodeOf('nope')).toBeUndefined()
  })
})

describe('captureError → the queue (with consent on), and nothing (with consent off)', () => {
  it('the queued event has the frames scrubbed of the username and no trace of the message', () => {
    configureTelemetry({ userDataDir: dir, isEnabled: () => true })
    captureError('main:uncaughtException', plantedError())
    const queued = listQueued()
    expect(queued).toHaveLength(1)
    const [e] = queued
    expect(e.kind).toBe('error')
    expect(e.name).toBe('error.main-uncaughtexception')
    expect(e.props.errorClass).toBe('TypeError')
    const serialized = JSON.stringify(e)
    expect(serialized).not.toContain('danawhitfield')
    expect(serialized).not.toContain(TRANSCRIPT)
    expect(serialized).not.toContain('forty thousand')
    expect(serialized).toContain('C:\\\\Users\\\\<user>\\\\AppData') // path shape survives for debugging
  })

  it('with consent off, captureError writes nothing at all', async () => {
    configureTelemetry({ userDataDir: dir, isEnabled: () => false })
    captureError('main:uncaughtException', plantedError())
    captureRendererGone({ reason: 'crashed', exitCode: 5 })
    captureChildGone({ type: 'GPU', reason: 'killed', exitCode: 1 })
    expect(listQueued()).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  it('renderer-gone and child-gone are crash events with reason + exit code only', () => {
    configureTelemetry({ userDataDir: dir, isEnabled: () => true })
    captureRendererGone({ reason: 'oom', exitCode: -1 })
    captureChildGone({ type: 'Utility', reason: 'crashed', exitCode: 3, name: 'network' } as never)
    const [r, c] = listQueued()
    expect(r).toMatchObject({
      kind: 'crash',
      name: 'crash.renderer',
      props: { reason: 'oom', exitCode: -1 }
    })
    expect(c).toMatchObject({
      kind: 'crash',
      name: 'crash.child',
      props: { processType: 'Utility', reason: 'crashed', exitCode: 3 }
    })
    expect(Object.keys(c.props)).not.toContain('name') // extra fields are not forwarded
  })

  it('never throws, even on hostile input', () => {
    configureTelemetry({ userDataDir: dir, isEnabled: () => true })
    expect(() => captureError('', undefined)).not.toThrow()
    expect(() => captureRendererGone({})).not.toThrow()
    expect(() => captureChildGone({ type: 42, reason: null })).not.toThrow()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(() => captureError('x', circular)).not.toThrow()
  })
})

describe('native crash dumps — counted, never shipped', () => {
  async function dump(name: string, ageSeconds: number): Promise<void> {
    const p = join(dir, 'Crashpad', 'reports', name)
    await mkdir(join(dir, 'Crashpad', 'reports'), { recursive: true })
    await writeFile(p, 'MDMP fake minidump bytes')
    const t = (Date.now() - ageSeconds * 1000) / 1000
    await utimes(p, t, t)
  }

  it('first run baselines existing dumps (they predate consent); later runs count only new ones', async () => {
    const marker = join(dir, 'marker.json')
    await dump('old-1.dmp', 600)
    await dump('old-2.dmp', 500)
    expect(checkNativeCrashes(dir, marker)).toEqual({ newDumps: 0, baselined: true })
    expect(checkNativeCrashes(dir, marker)).toEqual({ newDumps: 0, baselined: false })
    await dump('new-1.dmp', 10)
    await dump('new-2.dmp', 5)
    expect(checkNativeCrashes(dir, marker)).toEqual({ newDumps: 2, baselined: false })
    expect(checkNativeCrashes(dir, marker)).toEqual({ newDumps: 0, baselined: false }) // counted once
  })

  it('tolerates a missing dump directory and a corrupt marker', async () => {
    const marker = join(dir, 'm.json')
    expect(checkNativeCrashes(join(dir, 'does-not-exist'), marker)).toEqual({
      newDumps: 0,
      baselined: true
    })
    await writeFile(marker, '{not json')
    expect(checkNativeCrashes(join(dir, 'does-not-exist'), marker).newDumps).toBe(0)
  })
})
