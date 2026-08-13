// @vitest-environment happy-dom
//
// BUG-051 — "Sync now" runs a RESTORE (pulling other devices' changes down)
// and then a BACKUP (pushing this device's changes up), but the card showed
// one undifferentiated "Syncing…" for both. That matters: a slow restore
// means "your data is still arriving from your other device", a slow backup
// means "the work you just did isn't saved yet" — opposite implications if
// you quit mid-way, and the UI gave you no way to tell them apart.
//
// These drive the REAL card against an in-memory stand-in for the job store.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job } from '../../../../../preload/index.d'

// platform.ts reads window.electron.process at module load, which the
// preload bridge supplies in the real app but nothing does here.
vi.mock('@renderer/lib/platform', () => ({ isMac: false, isWindows: true }))

const { BackupCard } = await import('../BackupCard')

const SYNC_JOB_TYPE = 'backup:sync'

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'sync-1',
    type: SYNC_JOB_TYPE,
    title: 'Syncing with the cloud',
    state: 'running',
    progress: { mode: 'stages', stageLabel: 'Waiting for background sync to finish…' },
    lane: 'MAINTENANCE',
    priority: 0,
    createdAt: 0,
    cancellable: false,
    input: {},
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root | null
let store: Job[]
let listeners: Array<(jobs: Job[]) => void>

function emit(): void {
  const snapshot = [...store]
  listeners.forEach((cb) => cb(snapshot))
}

function setStage(label: string): void {
  store = store.map((j) => ({ ...j, progress: { mode: 'stages' as const, stageLabel: label } }))
  emit()
}

function setupApi(): void {
  store = []
  listeners = []
  ;(window as unknown as { api: unknown }).api = {
    jobs: {
      list: () => Promise.resolve([...store]),
      get: (id: string) => Promise.resolve(store.find((j) => j.id === id) ?? null),
      onChanged: (cb: (jobs: Job[]) => void) => {
        listeners.push(cb)
        return () => {
          listeners = listeners.filter((l) => l !== cb)
        }
      }
    },
    backup: {
      getStatus: () =>
        Promise.resolve({ lastSyncAt: '2026-08-13T00:00:00.000Z', conflictCount: 0 }),
      syncNow: () => {
        const job = makeJob({ id: `sync-${store.length + 1}` })
        store.push(job)
        return Promise.resolve({ ok: true, jobId: job.id })
      },
      revealConflicts: () => Promise.resolve({ ok: true }),
      onChanged: () => () => {}
    },
    settings: {
      get: () =>
        Promise.resolve({
          syncScope: {
            transcripts: false,
            attachments: false,
            knowledgeBase: false,
            settingsPersonalization: false,
            contacts: false
          }
        }),
      update: () => Promise.resolve({ ok: true }),
      onChanged: () => () => {}
    }
  }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function mountCard(): Promise<void> {
  const el = document.createElement('div')
  container.appendChild(el)
  root = createRoot(el)
  await act(async () => {
    root!.render(createElement(BackupCard))
    await Promise.resolve()
  })
  await flush()
}

async function unmountCard(): Promise<void> {
  await act(async () => root?.unmount())
  root = null
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

function syncButton(): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find((b) =>
    /Sync now|Restoring|Backing up|Waiting/.test(b.textContent ?? '')
  ) as HTMLButtonElement | undefined
}

describe('BackupCard — telling a restore apart from a backup (BUG-051)', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    setupApi()
  })

  afterEach(async () => {
    await unmountCard()
    container.remove()
  })

  it('says RESTORING while pulling changes down', async () => {
    await mountCard()
    await act(async () => void syncButton()?.click())
    await flush()

    setStage('Restoring changes from the cloud…')
    await flush()

    expect(bodyText()).toContain('Restoring changes from the cloud')
    expect(bodyText()).not.toContain('Backing up to the cloud')
  })

  it('says BACKING UP while pushing changes up — visibly different from the restore half', async () => {
    await mountCard()
    await act(async () => void syncButton()?.click())
    await flush()

    setStage('Backing up to the cloud…')
    await flush()

    expect(bodyText()).toContain('Backing up to the cloud')
    expect(bodyText()).not.toContain('Restoring changes from the cloud')
  })

  it('the two halves produce DIFFERENT text — the whole point of the fix', async () => {
    await mountCard()
    await act(async () => void syncButton()?.click())
    await flush()

    setStage('Restoring changes from the cloud…')
    await flush()
    const restoringText = syncButton()?.textContent ?? ''

    setStage('Backing up to the cloud…')
    await flush()
    const backingUpText = syncButton()?.textContent ?? ''

    expect(restoringText).not.toBe(backingUpText)
    expect(restoringText).toContain('Restoring')
    expect(backingUpText).toContain('Backing up')
  })

  it('adopts a sync already in flight when Settings is opened mid-sync, instead of showing an idle button', async () => {
    // A sync started elsewhere (launch, or the rep left and came back).
    store = [
      makeJob({ progress: { mode: 'stages', stageLabel: 'Restoring changes from the cloud…' } })
    ]
    await mountCard()

    expect(bodyText()).toContain('Restoring changes from the cloud')
    expect(syncButton()?.textContent).toContain('Restoring')
  })

  it('returns to the idle "Sync now" state once the job finishes', async () => {
    await mountCard()
    await act(async () => void syncButton()?.click())
    await flush()
    setStage('Backing up to the cloud…')
    await flush()
    expect(syncButton()?.textContent).toContain('Backing up')

    store = store.map((j) => ({ ...j, state: 'succeeded' as const }))
    await act(async () => {
      emit()
      await Promise.resolve()
    })
    await flush()

    expect(syncButton()?.textContent).toContain('Sync now')
  })
})
