// M29 A2.2 — recordAiFailure/recordAiSuccess feed the aggregate telemetry
// signals. The privacy claim under test: `info.detail` (the provider's raw
// error prose, which can echo request fragments) NEVER reaches the queue —
// only the code, the class, and the vendor. Same real-file pattern as
// purpose-health-store.test.ts: only 'electron' is stubbed; telemetry runs
// against the same temp dir.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: { handle: vi.fn() }
}))

const PROSE = 'Provider said: cannot summarize call with Dana about the forty thousand budget'

async function fresh(): Promise<{
  store: typeof import('../purpose-health-store')
  telemetry: typeof import('../../telemetry/index')
  setup: typeof import('../../telemetry/setup')
  consent: typeof import('../../telemetry/consent')
}> {
  vi.resetModules()
  const telemetry = await import('../../telemetry/index')
  const setup = await import('../../telemetry/setup')
  const consent = await import('../../telemetry/consent')
  const store = await import('../purpose-health-store')
  setup.setupTelemetry({ userDataDir: dir, appVersion: '1.4.0', crashDumpsDir: join(dir, 'dumps') })
  return { store, telemetry, setup, consent }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phs-telemetry-'))
})
afterEach(async () => {
  // The store's persist() is throttled and fire-and-forget; on Windows a
  // write landing mid-rm makes rmdir fail with ENOTEMPTY. Flush first (the
  // export exists for exactly this), then remove with a short retry.
  const store = await import('../purpose-health-store')
  await store.flushPendingWritesForTests()
  const { resetTelemetry } = await import('../../telemetry/index')
  resetTelemetry()
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      break
    } catch (err) {
      if (attempt >= 4) throw err
      await new Promise((r) => setTimeout(r, 50))
    }
  }
})

describe('AI purpose failures become aggregate signals — never the detail', () => {
  it('a failure lands code + class + vendor; the planted provider prose appears nowhere', async () => {
    const { store, telemetry, consent } = await fresh()
    consent.setConsent(dir, 'on')
    await store.recordAiFailure('memory-extract', {
      reason: 'rate-limit',
      providerId: 'google',
      detail: PROSE, // control input: the prose is really in the call
      failureClass: 'period-exhausted'
    })
    const events = telemetry.listQueued()
    const failed = events.filter((e) => e.name === 'ai.purpose.failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].props).toEqual({
      purpose: 'memory-extract',
      failureClass: 'period-exhausted',
      code: 'rate-limit',
      providerId: 'google'
    })
    const all = JSON.stringify(events)
    expect(PROSE).toContain('Dana') // the control really contains content
    expect(all).not.toContain('Dana')
    expect(all).not.toContain('forty thousand')
    expect(all).not.toContain('detail')
  })

  it('a success after a streak emits recovered with the streak length; a plain success emits nothing', async () => {
    const { store, telemetry, consent } = await fresh()
    consent.setConsent(dir, 'on')
    for (let i = 0; i < 3; i++) {
      await store.recordAiFailure('scorecard', { reason: 'timeout', providerId: 'groq' })
    }
    await store.recordAiSuccess('scorecard', { providerId: 'groq', fromImplicitTail: false })
    const recovered = telemetry.listQueued().filter((e) => e.name === 'ai.purpose.recovered')
    expect(recovered).toHaveLength(1)
    expect(recovered[0].props).toEqual({ purpose: 'scorecard', afterConsecutiveFailures: 3 })

    await store.recordAiSuccess('scorecard', { providerId: 'groq', fromImplicitTail: false })
    expect(telemetry.listQueued().filter((e) => e.name === 'ai.purpose.recovered')).toHaveLength(1)
  })

  it('with consent off, the store still records health locally but no telemetry event exists', async () => {
    const { store, telemetry } = await fresh()
    await store.recordAiFailure('summary', { reason: 'auth', providerId: 'anthropic' })
    await store.flushPendingWritesForTests()
    expect(telemetry.listQueued()).toEqual([])
    // the LOCAL purpose-health record still works — telemetry off never
    // degrades the app's own self-knowledge
    const { loadForTests } = store as unknown as { loadForTests?: unknown }
    void loadForTests // (no such export — the on-disk file is the evidence)
    const fs = await import('node:fs/promises')
    const raw = JSON.parse(await fs.readFile(join(dir, 'ai-purpose-health.json'), 'utf8'))
    expect(raw.summary.consecutiveFailures).toBe(1)
  })
})
