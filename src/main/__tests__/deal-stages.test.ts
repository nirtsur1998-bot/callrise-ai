import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDeal } from '../deals-fs'

let dir: string

const mocks = vi.hoisted(() => ({ scheduleBackup: vi.fn() }))
vi.mock('../backup', () => ({ scheduleBackup: mocks.scheduleBackup }))
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: { handle: vi.fn() }
}))

async function freshModule(): Promise<typeof import('../deal-stages')> {
  vi.resetModules()
  return import('../deal-stages')
}

function dealsDir(): string {
  return join(dir, 'deals')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-stages-'))
  mocks.scheduleBackup.mockClear()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadDealStages / loadDealStagesMeta', () => {
  it('falls back to the default pipeline when no file exists yet', async () => {
    const { loadDealStages } = await freshModule()
    const stages = loadDealStages()
    expect(stages.map((s) => s.id)).toEqual([
      'lead',
      'discovery',
      'proposal',
      'negotiating',
      'won',
      'lost',
      // M32 Stage 2 — a DELIBERATE addition to the default pipeline, not drift.
      // 'went-quiet' is a distinct outcome from 'lost': the founder's framing is
      // that these deals fade rather than end, and merging the two would poison
      // the comparison Stage 2 exists to make. Kept as an exact toEqual so the
      // next addition is also a decision rather than a surprise.
      'went-quiet'
    ])
  })

  it('falls back to defaults on a corrupt file rather than throwing', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'deal-stages.json'), '{ not json')
    const { loadDealStages } = await freshModule()
    // 7 since M32 Stage 2 added 'went-quiet' to the default pipeline. Asserting
    // the COUNT rather than the ids is the point of this test — it is about
    // "corrupt input still yields the full default set", not about which stages
    // those are (the test above pins those exactly).
    expect(loadDealStages()).toHaveLength(7)
  })

  it('reads updatedAt back as EPOCH for a file saved before the field existed', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'deal-stages.json'), JSON.stringify({ stages: [] }))
    const { loadDealStagesMeta } = await freshModule()
    expect(loadDealStagesMeta().updatedAt).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('setDealStages', () => {
  it('replaces the stage list and persists it', async () => {
    const { setDealStages, loadDealStages } = await freshModule()
    const result = setDealStages([{ id: 'custom-a', label: 'Custom A', kind: 'open' }])
    expect(result.ok).toBe(true)
    expect(loadDealStages()).toEqual([{ id: 'custom-a', label: 'Custom A', kind: 'open' }])
  })

  it('never accepts an empty stage list — a pipeline cannot have zero stages', async () => {
    const { setDealStages } = await freshModule()
    const result = setDealStages([])
    expect(result).toEqual({ ok: false, error: 'empty' })
  })

  it('rejects removing a stage that still has open deals in it', async () => {
    const { setDealStages } = await freshModule()
    await createDeal(dealsDir(), { title: 'Acme', contactId: 'contact-1', stageId: 'lead' })
    const result = setDealStages([{ id: 'discovery', label: 'Discovery', kind: 'open' }])
    expect(result).toEqual({ ok: false, error: 'stage-in-use' })
  })

  it('allows removing a stage once it has no deals in it', async () => {
    const { setDealStages } = await freshModule()
    const result = setDealStages([{ id: 'discovery', label: 'Discovery', kind: 'open' }])
    expect(result.ok).toBe(true)
  })

  it('schedules a backup on every successful change', async () => {
    const { setDealStages } = await freshModule()
    setDealStages([{ id: 'a', label: 'A', kind: 'open' }])
    expect(mocks.scheduleBackup).toHaveBeenCalledOnce()
  })

  it('does not schedule a backup on a rejected change', async () => {
    const { setDealStages } = await freshModule()
    setDealStages([])
    expect(mocks.scheduleBackup).not.toHaveBeenCalled()
  })
})

describe('applyPulledDealStages — never orphan a deal', () => {
  it('appends back a local stage still in use even if the pull dropped it', async () => {
    const { setDealStages, applyPulledDealStages, loadDealStages } = await freshModule()
    setDealStages([
      { id: 'lead', label: 'Lead', kind: 'open' },
      { id: 'discovery', label: 'Discovery', kind: 'open' }
    ])
    await createDeal(dealsDir(), { title: 'Acme', contactId: 'contact-1', stageId: 'discovery' })

    // The cloud's pipeline no longer has 'discovery' — a naive apply would
    // orphan the deal sitting in it.
    applyPulledDealStages([{ id: 'lead', label: 'Lead', kind: 'open' }], '2026-01-01T00:00:00.000Z')

    const ids = loadDealStages().map((s) => s.id)
    expect(ids).toContain('lead')
    expect(ids).toContain('discovery') // kept, because it's still in use
  })

  it('drops a local stage that is no longer in use', async () => {
    const { setDealStages, applyPulledDealStages, loadDealStages } = await freshModule()
    setDealStages([
      { id: 'lead', label: 'Lead', kind: 'open' },
      { id: 'unused', label: 'Unused', kind: 'open' }
    ])
    applyPulledDealStages([{ id: 'lead', label: 'Lead', kind: 'open' }], '2026-01-01T00:00:00.000Z')
    expect(loadDealStages().map((s) => s.id)).toEqual(['lead'])
  })

  it('keeps the cloud timestamp when nothing had to be appended (no restamp on a pure pull)', async () => {
    const { applyPulledDealStages, loadDealStagesMeta } = await freshModule()
    applyPulledDealStages([{ id: 'lead', label: 'Lead', kind: 'open' }], '2020-05-05T00:00:00.000Z')
    expect(loadDealStagesMeta().updatedAt).toBe('2020-05-05T00:00:00.000Z')
  })

  it('re-stamps with now() when a local in-use stage had to be appended', async () => {
    const { setDealStages, applyPulledDealStages, loadDealStagesMeta } = await freshModule()
    setDealStages([{ id: 'discovery', label: 'Discovery', kind: 'open' }])
    await createDeal(dealsDir(), { title: 'Acme', contactId: 'contact-1', stageId: 'discovery' })
    applyPulledDealStages([{ id: 'lead', label: 'Lead', kind: 'open' }], '2020-05-05T00:00:00.000Z')
    expect(loadDealStagesMeta().updatedAt).not.toBe('2020-05-05T00:00:00.000Z')
  })

  it('ignores a non-array payload rather than wiping the pipeline', async () => {
    const { setDealStages, applyPulledDealStages, loadDealStages } = await freshModule()
    setDealStages([{ id: 'lead', label: 'Lead', kind: 'open' }])
    applyPulledDealStages('not an array', '2026-01-01T00:00:00.000Z')
    expect(loadDealStages()).toEqual([{ id: 'lead', label: 'Lead', kind: 'open' }])
  })
})

describe('stage-id safety', () => {
  it('drops an entry with no usable label', async () => {
    const { setDealStages, loadDealStages } = await freshModule()
    setDealStages([
      { id: 'lead', label: '   ', kind: 'open' },
      { id: 'ok', label: 'OK', kind: 'open' }
    ])
    expect(loadDealStages().map((s) => s.id)).toEqual(['ok'])
  })

  it("mints a fresh id for one that would collide with deals-fs.ts's ID_RE-unsafe input", async () => {
    const { setDealStages, loadDealStages } = await freshModule()
    setDealStages([{ id: 'bad id with spaces', label: 'Weird', kind: 'open' }])
    const stages = loadDealStages()
    expect(stages).toHaveLength(1)
    expect(stages[0].id).not.toBe('bad id with spaces')
    expect(stages[0].id).toMatch(/^[A-Za-z0-9-]+$/)
  })

  it('mints a fresh id rather than allowing a duplicate', async () => {
    const { setDealStages, loadDealStages } = await freshModule()
    setDealStages([
      { id: 'dup', label: 'First', kind: 'open' },
      { id: 'dup', label: 'Second', kind: 'open' }
    ])
    const stages = loadDealStages()
    expect(stages).toHaveLength(2)
    expect(new Set(stages.map((s) => s.id)).size).toBe(2)
  })

  it('defaults an unrecognised kind to open', async () => {
    const { setDealStages, loadDealStages } = await freshModule()
    setDealStages([{ id: 'x', label: 'X', kind: 'archived' }])
    expect(loadDealStages()[0].kind).toBe('open')
  })
})
