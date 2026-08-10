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
