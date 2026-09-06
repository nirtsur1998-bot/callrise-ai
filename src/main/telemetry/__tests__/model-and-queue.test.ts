// M29 A1.1 — event model, anonymous id, local queue, and the front door.
// Every negative assertion has a positive twin in the same test so none can
// pass vacuously. The userData directory is a fresh temp dir per test; the
// real app directory is never touched.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildEvent, isTelemetryEvent, LIMITS, type TelemetryEvent } from '../events'
import { anonIdPath, deleteAnonId, getOrCreateAnonId, readAnonId } from '../anon-id'
import { TelemetryQueue } from '../queue'
import {
  ackSent,
  clearQueued,
  configureTelemetry,
  isTelemetryEnabled,
  listQueued,
  record,
  resetTelemetry
} from '../index'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-telemetry-'))
})
afterEach(async () => {
  resetTelemetry()
  await rm(dir, { recursive: true, force: true })
})

const fixed = { now: () => new Date('2026-08-23T12:00:00.000Z'), id: () => 'evt-1' }

describe('buildEvent — the shape is the privacy policy', () => {
  it('accepts strings, numbers and booleans and scrubs the strings', () => {
    const r = buildEvent(
      'error',
      'main.uncaughtException',
      {
        errorClass: 'TypeError',
        count: 3,
        fatal: false,
        stack: '    at x (C:\\Users\\danawhitfield\\a.js:1:1)'
      },
      fixed
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event).toEqual({
      id: 'evt-1',
      ts: '2026-08-23T12:00:00.000Z',
      kind: 'error',
      name: 'main.uncaughtException',
      props: {
        errorClass: 'TypeError',
        count: 3,
        fatal: false,
        stack: '    at x (C:\\Users\\<user>\\a.js:1:1)'
      }
    })
  })

  it('rejects structure: objects, arrays, null, undefined, functions', () => {
    for (const bad of [{ a: 1 }, [1, 2], null, undefined, () => 1, 10n]) {
      const r = buildEvent('usage', 'feature.rise.opened', { x: bad as never }, fixed)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/unsupported type/)
    }
  })

  it('rejects a props bag that is not a plain object, and too many props', () => {
    expect(buildEvent('usage', 'a.b', [1] as never, fixed).ok).toBe(false)
    expect(buildEvent('usage', 'a.b', 'str' as never, fixed).ok).toBe(false)
    const many: Record<string, number> = {}
    for (let i = 0; i < LIMITS.MAX_PROPS + 1; i++) many[`k${i}`] = i
    const r = buildEvent('usage', 'a.b', many, fixed)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/too many props/)
  })

  it('rejects unknown kinds, prose-shaped names, and non-identifier keys', () => {
    expect(buildEvent('metrics', 'a.b', {}, fixed).ok).toBe(false)
    expect(buildEvent('usage', 'the user clicked the thing', {}, fixed).ok).toBe(false)
    expect(buildEvent('usage', 'Feature.Opened', {}, fixed).ok).toBe(false) // must start lower-case
    expect(buildEvent('usage', 'a.b', { 'has space': 1 }, fixed).ok).toBe(false)
    expect(buildEvent('usage', 'a.b', { ['x'.repeat(40)]: 1 }, fixed).ok).toBe(false)
  })

  it('string props must be tokens — prose (anything with whitespace) is rejected outright', () => {
    const prose = 'Buyer said our budget is forty thousand'
    const r = buildEvent('usage', 'a.b', { label: prose }, fixed)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a token/)
    for (const ok of [
      'TypeError',
      'ERR_UPDATER_INVALID_VERSION',
      'main:uncaughtException',
      '1.4.0',
      'a/b-c_d.e@f+g'
    ]) {
      expect(buildEvent('usage', 'a.b', { t: ok }, fixed).ok, ok).toBe(true)
    }
    expect(buildEvent('usage', 'a.b', { t: 'x'.repeat(129) }, fixed).ok).toBe(false)
    expect(buildEvent('usage', 'a.b', { t: '' }, fixed).ok).toBe(false)
  })

  it("the 'stack' prop is reduced to frames: a whole stack loses its message line, a bare message vanishes", () => {
    const stack = [
      'TypeError: secret message with spaces',
      '    at f (C:\\Users\\danawhitfield\\x.js:1:1)',
      '    at g (y.js:2:2)'
    ].join('\n')
    expect(stack).toContain('secret message') // control
    const r = buildEvent('error', 'a.b', { stack }, fixed)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.event.props.stack).toBe('    at f (C:\\Users\\<user>\\x.js:1:1)\n    at g (y.js:2:2)')
    const none = buildEvent('error', 'a.b', { stack: 'just a message, no frames at all' }, fixed)
    expect(none.ok && 'stack' in none.event.props).toBe(false)
    const many = [
      'Error: m',
      ...Array.from({ length: 60 }, (_, i) => `    at f${i} (x.js:${i}:1)`)
    ].join('\n')
    const capped = buildEvent('error', 'a.b', { stack: many }, fixed)
    expect(capped.ok && String(capped.event.props.stack).split('\n')).toHaveLength(
      LIMITS.MAX_FRAMES
    )
  })

  it('rejects non-finite numbers and never throws on garbage', () => {
    expect(buildEvent('usage', 'a.b', { n: Number.NaN }, fixed).ok).toBe(false)
    expect(buildEvent('usage', 'a.b', { n: Number.POSITIVE_INFINITY }, fixed).ok).toBe(false)
    expect(() => buildEvent(Symbol('x') as never, 1 as never, 2 as never, fixed)).not.toThrow()
  })

  it('isTelemetryEvent rejects what a hand-edited queue file could contain', () => {
    const good = buildEvent('usage', 'a.b', { n: 1 }, fixed)
    expect(good.ok && isTelemetryEvent(good.event)).toBe(true)
    expect(isTelemetryEvent({ ...(good.ok ? good.event : {}), props: { nested: { a: 1 } } })).toBe(
      false
    )
    expect(isTelemetryEvent({ ...(good.ok ? good.event : {}), kind: 'content' })).toBe(false)
    expect(isTelemetryEvent('not an object')).toBe(false)
  })
})

describe('anonymous id — separate from everything', () => {
  it('does not exist until created, is a UUID, is stable, and is deleted on opt-out', () => {
    expect(readAnonId(dir)).toBeNull()
    expect(existsSync(anonIdPath(dir))).toBe(false)
    const a = getOrCreateAnonId(dir)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(getOrCreateAnonId(dir)).toBe(a)
    expect(readAnonId(dir)).toBe(a)
    deleteAnonId(dir)
    expect(readAnonId(dir)).toBeNull()
    const b = getOrCreateAnonId(dir)
    expect(b).not.toBe(a) // no continuity across consent
  })

  it('replaces a corrupt id file rather than trusting it', async () => {
    await writeFile(anonIdPath(dir), 'not-a-uuid\n')
    expect(readAnonId(dir)).toBeNull()
    expect(getOrCreateAnonId(dir)).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('is never the updater id and never the account id, even when both exist on disk', async () => {
    const updaterId = '11111111-2222-5333-8444-555555555555'
    await writeFile(join(dir, '.updaterId'), updaterId)
    await writeFile(
      join(dir, 'supabase-auth.json'),
      JSON.stringify({ user: { id: 'acct-uuid', email: 'rep@example.com' } })
    )
    const anon = getOrCreateAnonId(dir)
    expect(anon).not.toBe(updaterId)
    expect(anon).not.toContain('acct')
    const raw = await readFile(anonIdPath(dir), 'utf8')
    expect(raw).not.toContain('rep@example.com')
    expect(raw.trim()).toBe(anon)
  })
})

describe('queue — bounded, readable, tolerant', () => {
  const ev = (i: number): TelemetryEvent => {
    const r = buildEvent('usage', 'a.b', { i }, { now: () => new Date(0), id: () => `id-${i}` })
    if (!r.ok) throw new Error(r.reason)
    return r.event
  }

  it('appends, lists oldest-first, acks, clears', async () => {
    const q = new TelemetryQueue(dir)
    expect(q.list()).toEqual([])
    expect(q.append(ev(1))).toBe(true)
    expect(q.append(ev(2))).toBe(true)
    expect(q.list().map((e) => e.id)).toEqual(['id-1', 'id-2'])
    q.ack(new Set(['id-1']))
    expect(q.list().map((e) => e.id)).toEqual(['id-2'])
    q.clear()
    expect(q.list()).toEqual([])
    expect(existsSync(q.path)).toBe(false)
  })

  it('drops the oldest beyond the event cap', () => {
    const q = new TelemetryQueue(dir, { maxEvents: 5 })
    for (let i = 1; i <= 8; i++) q.append(ev(i))
    expect(q.list().map((e) => e.id)).toEqual(['id-4', 'id-5', 'id-6', 'id-7', 'id-8'])
  })

  it('drops the oldest beyond the byte cap', () => {
    const q = new TelemetryQueue(dir, { maxEvents: 1000, maxBytes: 400 })
    for (let i = 1; i <= 20; i++) q.append(ev(i))
    const kept = q.list()
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(20)
    expect(kept[kept.length - 1].id).toBe('id-20') // newest survives
  })

  it('skips a torn line and a hand-inserted structured line instead of throwing', async () => {
    const q = new TelemetryQueue(dir)
    q.append(ev(1))
    await writeFile(
      q.path,
      `${JSON.stringify(ev(1))}\n{"id":"x","ts":"t","kind":"usage","name":"a.b","props":{"deep":{"a":1}}}\n{"torn":\n${JSON.stringify(ev(2))}\n`
    )
    expect(q.list().map((e) => e.id)).toEqual(['id-1', 'id-2'])
  })
})

describe('front door — off means off, proven both ways', () => {
  it('writes ZERO bytes while disabled and bytes once enabled — same test, both branches', async () => {
    let enabled = false
    configureTelemetry({ userDataDir: dir, isEnabled: () => enabled })
    expect(isTelemetryEnabled()).toBe(false)

    const off = record('error', 'main.uncaughtException', {
      errorClass: 'X',
      stack: '    at x (C:\\Users\\danawhitfield\\x.js:1:1)'
    })
    expect(off).toEqual({ ok: false, reason: 'disabled' })
    expect(listQueued()).toEqual([])
    expect(await readdir(dir)).toEqual([]) // nothing at all was written — not even the id

    enabled = true // the consent gate is read fresh on every call
    const on = record('error', 'main.uncaughtException', {
      errorClass: 'X',
      stack: '    at x (C:\\Users\\danawhitfield\\x.js:1:1)'
    })
    expect(on.ok).toBe(true)
    expect(listQueued()).toHaveLength(1)
    const bytes = await readFile(join(dir, 'telemetry-queue.jsonl'), 'utf8')
    expect(bytes).toContain('main.uncaughtException') // the control: bytes really landed
    expect(bytes).toContain('at x (') // the frame landed
    expect(bytes).not.toContain('danawhitfield') // and it was scrubbed on the way in

    enabled = false // opt-out is immediate, no restart, no cache
    expect(record('usage', 'feature.rise.opened')).toEqual({ ok: false, reason: 'disabled' })
    expect(listQueued()).toHaveLength(1) // nothing new
  })

  it('before configureTelemetry is ever called, record() is disabled and touches nothing', async () => {
    expect(isTelemetryEnabled()).toBe(false)
    expect(record('usage', 'feature.rise.opened')).toEqual({ ok: false, reason: 'disabled' })
    expect(await readdir(dir)).toEqual([])
  })

  it('a throwing consent gate fails CLOSED', async () => {
    configureTelemetry({
      userDataDir: dir,
      isEnabled: () => {
        throw new Error('settings unreadable')
      }
    })
    expect(isTelemetryEnabled()).toBe(false)
    expect(record('usage', 'feature.rise.opened').ok).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it('rejected events are reported, not thrown, and not queued', () => {
    configureTelemetry({ userDataDir: dir, isEnabled: () => true })
    const r = record('usage', 'feature.rise.opened', { nested: { a: 1 } as never })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unsupported type/)
    expect(listQueued()).toEqual([])
  })

  it('ackSent and clearQueued manage the same file the user can see', () => {
    configureTelemetry({ userDataDir: dir, isEnabled: () => true })
    const a = record('usage', 'feature.rise.opened')
    const b = record('usage', 'feature.call.coached')
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    ackSent(new Set([a.event.id]))
    expect(listQueued().map((e) => e.id)).toEqual([b.event.id])
    clearQueued()
    expect(listQueued()).toEqual([])
  })
})
