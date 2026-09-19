// BUG-285 — once the Call record exists, no follow-up may turn the save into
// a failure. The helper is tested directly; calls.ts (which cannot be
// imported in a unit test — it registers the whole IPC surface) is pinned
// from its source, the way objection-queue-backup.test.ts does it: every
// statement between `endSave()` and `return summary` goes through the helper.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { postSaveStep } from '../post-save-step'

afterEach(() => vi.restoreAllMocks())

describe('postSaveStep', () => {
  it('runs the step and resolves', async () => {
    const run = vi.fn(async () => 'done')
    await expect(postSaveStep('x', 'call-1', run)).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a step that THROWS synchronously is logged by name and swallowed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      postSaveStep('end-call', 'call-1', () => {
        throw new Error('consent store unavailable')
      })
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    const [line, err] = error.mock.calls[0]
    expect(String(line)).toContain('"end-call"')
    expect(String(line)).toContain('call-1 is saved')
    expect((err as Error).message).toBe('consent store unavailable')
  })

  it('a step that REJECTS is logged and swallowed too', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      postSaveStep('self-intro-name', 'call-2', async () => {
        throw new Error('EIO')
      })
    ).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('preserves order — the caller awaits it, so a later step sees an earlier one finished', async () => {
    const order: string[] = []
    await postSaveStep('a', 'c', async () => {
      await new Promise((r) => setTimeout(r, 5))
      order.push('a')
    })
    await postSaveStep('b', 'c', () => {
      order.push('b')
    })
    expect(order).toEqual(['a', 'b'])
  })
})

describe('calls:save is wired through it', () => {
  const calls = readFileSync(join(__dirname, '..', 'calls.ts'), 'utf8')
  const start = calls.indexOf("'calls:save',")
  // The first `endSave()` after the handler starts is in a COMMENT
  // ("beginSave()/endSave() bracket the write"); anchor on the real call,
  // which follows `summary = await saveCall(`.
  const saveAt = calls.indexOf('summary = await saveCall(', start)
  const endSaveAt = calls.indexOf('endSave()', saveAt)
  const returnAt = calls.indexOf('return summary', endSaveAt)
  const tail = calls.slice(endSaveAt, returnAt)

  it('the handler exists and the post-save span was found', () => {
    expect(start).toBeGreaterThan(0)
    expect(endSaveAt).toBeGreaterThan(start)
    expect(returnAt).toBeGreaterThan(endSaveAt)
    expect(tail.length).toBeLessThan(6000) // one handler's tail, not the file
  })

  it('every follow-up after the record exists runs through postSaveStep, by name', () => {
    for (const name of [
      'end-call',
      'schedule-backup',
      'auto-mine',
      'self-intro-name',
      'resolve-contact',
      'memory-extraction'
    ]) {
      expect(tail, `step "${name}" is wrapped`).toContain(`postSaveStep('${name}', summary.id`)
    }
  })

  it('none of the follow-ups is left bare (the pre-fix lines are gone)', () => {
    const stripped = tail.replace(/\/\/.*$/gm, '')
    for (const bare of [
      '\n      endCall({ saved: true })',
      '\n      scheduleBackup()',
      '\n      if (isObjectionMiningEnabled()) {',
      '\n      if (selfIntro?.key',
      '\n      enqueueCascadeJob(RESOLVE_CONTACT_JOB_TYPE',
      '\n      enqueueMemoryExtraction('
    ]) {
      expect(stripped, `bare call: ${bare.trim()}`).not.toContain(bare)
    }
  })

  it('the wrapped steps are awaited, so their order is the order they were always in', () => {
    const names = [...tail.matchAll(/await postSaveStep\('([a-z-]+)'/g)].map((m) => m[1])
    expect(names).toEqual([
      'end-call',
      'schedule-backup',
      'auto-mine',
      'self-intro-name',
      'resolve-contact',
      'memory-extraction'
    ])
  })
})
