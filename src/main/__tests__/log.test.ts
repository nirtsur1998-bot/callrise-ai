// Phase 4 (once-and-for-all sweep) — regression tests for the persistent
// error log added so a field report has one small file to attach.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() }
}))

const { logError, logInfo, logFilePath } = await import('../log')

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'callrise-log-test-'))
})

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true })
})

describe('logError / logInfo', () => {
  it('writes an ERROR line with the stack for a real Error', async () => {
    logError('test:scope', new Error('boom'))
    const content = await readFile(logFilePath(), 'utf8')
    expect(content).toContain('ERROR test:scope')
    expect(content).toContain('Error: boom')
  })

  it('stringifies a non-Error value instead of throwing', async () => {
    logError('test:scope', 'a plain string reason')
    const content = await readFile(logFilePath(), 'utf8')
    expect(content).toContain('a plain string reason')
  })

  it('appends extra context as JSON when provided', async () => {
    logError('test:scope', new Error('boom'), { callId: 'abc123' })
    const content = await readFile(logFilePath(), 'utf8')
    expect(content).toContain('"callId":"abc123"')
  })

  it('writes an INFO line', async () => {
    logInfo('test:scope', 'started up fine')
    const content = await readFile(logFilePath(), 'utf8')
    expect(content).toContain('INFO test:scope: started up fine')
  })

  it('appends across multiple calls rather than overwriting', async () => {
    logInfo('a', 'first')
    logInfo('b', 'second')
    const content = await readFile(logFilePath(), 'utf8')
    expect(content).toContain('first')
    expect(content).toContain('second')
  })
})

describe('rotation', () => {
  it('rotates the file to .old.log once it exceeds the size cap, keeping it bounded', async () => {
    // Pre-seed a file just over the 2MB cap so the next write triggers rotation.
    await writeFile(logFilePath(), 'x'.repeat(2 * 1024 * 1024 + 1))
    logInfo('test', 'triggers rotation')

    const rotatedPath = logFilePath().replace(/\.log$/, '.old.log')
    const rotatedStat = await stat(rotatedPath)
    expect(rotatedStat.size).toBeGreaterThan(2 * 1024 * 1024)

    const freshContent = await readFile(logFilePath(), 'utf8')
    expect(freshContent).toContain('triggers rotation')
    expect(freshContent.length).toBeLessThan(1000)
  })
})

// M29 A1.0 — the log file is an egress (users email it to support), so it is
// scrubbed at the single write chokepoint. Control assertions prove the raw
// input carried the secret; red-checked by removing `scrub()` from appendLine.
describe('scrubbing at the write chokepoint', () => {
  it('a stack carrying a Windows user-profile path and an API key reaches the file without either', async () => {
    const err = new Error('boom')
    err.stack = [
      'Error: boom',
      '    at startCall (C:\\Users\\nirtsur\\AppData\\Local\\Programs\\CallRiseAI\\resources\\app.asar\\out\\main\\index.js:10:5)',
      '    provider said: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    ].join('\n')
    expect(err.stack).toContain('nirtsur') // control
    expect(err.stack).toContain('sk-ant-api03') // control
    logError('test:scope', err, { email: 'rep@example.com' })
    const content = await readFile(logFilePath(), 'utf8')
    expect(content).not.toContain('nirtsur')
    expect(content).not.toContain('sk-ant-api03')
    expect(content).not.toContain('rep@example.com')
    expect(content).toContain('C:\\Users\\<user>\\AppData') // path shape kept for debugging
    expect(content).toContain('ERROR test:scope: Error: boom') // the record itself survives
  })

  it('INFO lines and renderer-forwarded messages go through the same chokepoint', async () => {
    logInfo('renderer:x', 'saved to /Users/nirtsur/Library/x.json')
    const content = await readFile(logFilePath(), 'utf8')
    expect(content).not.toContain('nirtsur')
    expect(content).toContain('/Users/<user>/Library/x.json')
  })

  it('keeps one record per line even when the scrubber truncates a huge entry', async () => {
    logInfo('big', 'word '.repeat(2000)) // ~10 KB, over the scrubber cap
    logInfo('after', 'next record')
    const content = await readFile(logFilePath(), 'utf8')
    const lines = content.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('<truncated')
    expect(lines[1]).toContain('INFO after: next record')
  })
})

// M29 A1.2 — the same handler writes the local log line AND (opt-in only) a
// telemetry event. Driven directly; emitting a real 'uncaughtException' would
// take the test runner down with it.
describe('main-process error handler feeds the telemetry queue only when consent is on', () => {
  it('off: log line yes, queue no; on: both — same handler, both branches', async () => {
    const telemetry = await import('../telemetry/index')
    const { onMainProcessError, onRendererError } = await import('../log')
    let enabled = false
    telemetry.configureTelemetry({ userDataDir, isEnabled: () => enabled })
    try {
      onMainProcessError('main:uncaughtException', new TypeError('first'))
      expect(await readFile(logFilePath(), 'utf8')).toContain('TypeError: first')
      expect(telemetry.listQueued()).toEqual([])

      enabled = true
      onMainProcessError('main:unhandledRejection', new RangeError('second'))
      onRendererError(
        'window.onerror',
        'ReferenceError: x is not defined\n    at a (index-abc.js:1:1)'
      )
      const queued = telemetry.listQueued()
      expect(queued.map((e) => [e.kind, e.name, e.props.errorClass])).toEqual([
        ['error', 'error.main-unhandledrejection', 'RangeError'],
        ['error', 'error.renderer-window-onerror', 'ReferenceError']
      ])
      expect(JSON.stringify(queued)).not.toContain('second') // the message never travels
      expect(await readFile(logFilePath(), 'utf8')).toContain('RangeError: second') // but the local log keeps it
    } finally {
      telemetry.resetTelemetry()
    }
  })
})
