// BUG-079 — the Settings → Model Assignment picker renders a card for every
// job in ModelAssignmentSection.tsx's JOBS array (9 purposes), but
// ASSIGNABLE_PURPOSES here had only 7: 'coaching-chat' and 'memory-extract'
// were missing. Both settings:assignPrimaryModel and settings:resetToAutomatic
// silently return the settings UNCHANGED for a purpose outside the allowlist
// (no error thrown), so the picker just snapped back to "Automatic" with the
// user's pick discarded. Same real-file persistence pattern as
// purpose-health-store.test.ts (only 'electron' is stubbed).
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string
const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => dir },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, fn)
  }
}))

async function freshModule(): Promise<typeof import('../catalog-ipc')> {
  vi.resetModules()
  ipcHandlers.clear()
  return import('../catalog-ipc')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'catalog-ipc-test-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// A real id from MODEL_CATALOG (model-catalog.ts) so catalogEntry() succeeds.
const CATALOG_ID = 'groq-llama-3.3-70b-versatile'

describe('settings:assignPrimaryModel — every purpose the picker renders a card for', () => {
  it.each(['coaching-chat', 'memory-extract', 'coaching-cue', 'summary'] as const)(
    'persists a chosen model for %s',
    async (purpose) => {
      const { registerModelCatalog } = await freshModule()
      registerModelCatalog()

      const assign = ipcHandlers.get('settings:assignPrimaryModel')
      expect(assign).toBeDefined()
      // ipcMain.handle callbacks are always invoked as (event, ...args) by
      // real Electron - a dummy event object here, same as the real caller.
      const result = (await assign!({}, purpose, CATALOG_ID)) as {
        aiModelAssignments: Record<string, { chain: string[] }>
      }

      expect(result.aiModelAssignments[purpose].chain[0]).toBe(CATALOG_ID)
    }
  )

  it.each(['coaching-chat', 'memory-extract'] as const)(
    'settings:resetToAutomatic clears a previously assigned %s back to an empty chain',
    async (purpose) => {
      const { registerModelCatalog } = await freshModule()
      registerModelCatalog()

      const assign = ipcHandlers.get('settings:assignPrimaryModel')!
      await assign({}, purpose, CATALOG_ID)

      const reset = ipcHandlers.get('settings:resetToAutomatic')!
      const result = (await reset({}, purpose)) as {
        aiModelAssignments: Record<string, { chain: string[] }>
      }

      expect(result.aiModelAssignments[purpose].chain).toEqual([])
    }
  )
})
