// BUG-183 — the "Went quiet" migration must not fight itself across builds.
//
// The founder's real board grew FOUR "Went quiet" columns. Mechanism: a
// v1.6.0-or-older build has no `migrations` field and maps the unknown kind
// 'went-quiet' to 'open', so any stage write from it strips BOTH the marker
// and the kind; the next newer launch then finds no went-quiet stage, no
// marker, and appends a fresh one. Three alternations, three extra columns —
// and a card dragged into one of the clones records 'open', not went-quiet.
//
// The tests below simulate that older build directly on the file, because the
// older build cannot be changed and the migration has to survive it.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

const stagesFile = (): string => join(dir, 'deal-stages.json')

async function writeStagesFile(body: unknown): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(stagesFile(), JSON.stringify(body))
}

async function readStagesFile(): Promise<{
  stages: { id: string; label: string; kind: string }[]
  migrations?: string[]
}> {
  return JSON.parse(await readFile(stagesFile(), 'utf8'))
}

/** What a v1.6.0 build does to the file on any stage write: kinds it does not
 *  know become 'open', and `migrations` does not exist for it at all. */
async function rewriteAsOlderBuild(): Promise<void> {
  const cur = await readStagesFile()
  await writeStagesFile({
    stages: cur.stages.map((s) => ({
      ...s,
      kind: s.kind === 'won' || s.kind === 'lost' ? s.kind : 'open'
    })),
    updatedAt: new Date().toISOString()
  })
}

const wentQuiet = (stages: { label: string; kind: string }[]): { label: string; kind: string }[] =>
  stages.filter((s) => s.label.trim().toLowerCase() === 'went quiet')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'callrise-stages-migration-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("BUG-183 — 'Went quiet' across an older and a newer build", () => {
  it('the founder\'s real shape: four "Went quiet" stages collapse to the one real one', async () => {
    // Copied from the real deal-stages.json of 2026-09-04 (ids as they were).
    await writeStagesFile({
      stages: [
        { id: 'lead', label: 'Lead', kind: 'open' },
        { id: 'discovery', label: 'Discovery', kind: 'open' },
        { id: 'proposal', label: 'Proposal', kind: 'open' },
        { id: 'negotiating', label: 'Negotiating', kind: 'open' },
        { id: 'won', label: 'Won', kind: 'won' },
        { id: 'lost', label: 'Lost', kind: 'lost' },
        { id: 'went-quiet', label: 'Went quiet', kind: 'open' },
        { id: '1b2a7e20-6f7e-46ed-8753-be9105b47e0f', label: 'Went quiet', kind: 'open' },
        { id: 'f34736f1-6618-40e5-bc35-b3196df2cd74', label: 'Went quiet', kind: 'open' },
        { id: '404325fd-6b90-4daf-a4e2-d9b06ff1a2bc', label: 'Went quiet', kind: 'went-quiet' }
      ],
      updatedAt: '2026-09-02T04:11:10.447Z',
      migrations: ['went-quiet-v1']
    })
    const { migrateDealStages, loadDealStages } = await freshModule()
    expect(migrateDealStages()).toBe(true)
    const wq = wentQuiet(loadDealStages())
    expect(wq, 'the clones were not removed').toHaveLength(1)
    expect(wq[0].kind).toBe('went-quiet')
    expect(loadDealStages()).toHaveLength(7)
    expect((await readStagesFile()).migrations).toContain('went-quiet-dedupe-v1')
  })

  it('alternating with an older build REPAIRS the stage instead of appending another', async () => {
    const { migrateDealStages, loadDealStages, setDealStages } = await freshModule()
    // A pipeline the newer build has already migrated once.
    expect(setDealStages(loadDealStages()).ok).toBe(true)
    migrateDealStages()
    expect(wentQuiet(loadDealStages())).toHaveLength(1)

    for (let round = 1; round <= 3; round++) {
      await rewriteAsOlderBuild()
      // The older build's damage is real: kind gone, marker gone.
      expect(wentQuiet((await readStagesFile()).stages)[0].kind).toBe('open')
      expect((await readStagesFile()).migrations).toBeUndefined()

      const fresh = await freshModule()
      fresh.migrateDealStages()
      const wq = wentQuiet(fresh.loadDealStages())
      expect(wq, `round ${round}: a second "Went quiet" was appended`).toHaveLength(1)
      expect(wq[0].kind, `round ${round}: the kind was not repaired`).toBe('went-quiet')
    }
  })

  it('a clone that still holds a deal is kept — the dedupe never orphans a deal', async () => {
    await writeStagesFile({
      stages: [
        { id: 'won', label: 'Won', kind: 'won' },
        { id: 'lost', label: 'Lost', kind: 'lost' },
        { id: 'went-quiet', label: 'Went quiet', kind: 'went-quiet' },
        { id: 'clone-empty', label: 'Went quiet', kind: 'open' },
        { id: 'clone-used', label: 'Went quiet', kind: 'open' }
      ],
      updatedAt: new Date().toISOString(),
      migrations: ['went-quiet-v1']
    })
    const deal = await createDeal(join(dir, 'deals'), {
      title: 'Acme',
      contactId: 'c1',
      stageId: 'clone-used'
    })
    expect(deal, 'fixture failed: deal not created').not.toBeNull()

    const { migrateDealStages, loadDealStages } = await freshModule()
    migrateDealStages()
    const ids = loadDealStages().map((s) => s.id)
    expect(ids).not.toContain('clone-empty')
    expect(ids, 'a stage with a deal in it was removed').toContain('clone-used')
  })

  it('a marker this build does not recognise survives a load and an ordinary write', async () => {
    await writeStagesFile({
      stages: [
        { id: 'won', label: 'Won', kind: 'won' },
        { id: 'lost', label: 'Lost', kind: 'lost' },
        { id: 'went-quiet', label: 'Went quiet', kind: 'went-quiet' }
      ],
      updatedAt: new Date().toISOString(),
      migrations: ['went-quiet-v1', 'went-quiet-dedupe-v1', 'some-future-stage-v1']
    })
    const { loadDealStagesMeta, setDealStages, loadDealStages } = await freshModule()
    expect(loadDealStagesMeta().migrations).toContain('some-future-stage-v1')
    expect(setDealStages(loadDealStages()).ok).toBe(true)
    expect(
      (await readStagesFile()).migrations,
      'an ordinary stage edit dropped a marker it did not understand — the BUG-183 shape, one build later'
    ).toContain('some-future-stage-v1')
  })

  it('a deliberate deletion still sticks: marker present, no stage, nothing is re-added', async () => {
    await writeStagesFile({
      stages: [
        { id: 'won', label: 'Won', kind: 'won' },
        { id: 'lost', label: 'Lost', kind: 'lost' }
      ],
      updatedAt: new Date().toISOString(),
      migrations: ['went-quiet-v1', 'went-quiet-dedupe-v1']
    })
    const { migrateDealStages, loadDealStages } = await freshModule()
    expect(migrateDealStages()).toBe(false)
    expect(wentQuiet(loadDealStages())).toHaveLength(0)
  })
})
