// M28 — the 'assistant-chat' purpose must be genuinely assignable from the
// Settings picker. This is BUG-079's exact failure shape (a purpose with a
// Settings card missing from catalog-ipc.ts's ASSIGNABLE_PURPOSES allowlist,
// so assignment silently no-ops), written as a guard for the purpose M28
// introduces. Red check: removing 'assistant-chat' from ASSIGNABLE_PURPOSES
// fails the first two tests while the unknown-purpose control keeps passing.
// Deliberately a separate file from any BUG-079 hotfix suite (that fix lands
// off `main` in its own branch) so the two merge without collision.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => ipcHandlers.set(channel, fn)
  }
}))

// In-memory settings double: enough to observe whether the handler actually
// tried to persist (the bug's whole signature is that it never does).
const saveCalls: unknown[] = []
vi.mock('../../app-settings', () => ({
  loadAppSettings: () => ({ marker: 'unchanged-settings' }),
  saveAppSettings: (patch: unknown) => {
    saveCalls.push(patch)
    return { marker: 'saved-settings', patch }
  }
}))

async function registerFresh(): Promise<void> {
  vi.resetModules()
  ipcHandlers.clear()
  saveCalls.length = 0
  const { registerModelCatalog } = await import('../catalog-ipc')
  registerModelCatalog()
}

// A real catalog id present in QUALITY_CHAIN (assistant-chat's bundled chain).
const REAL_CATALOG_ID = 'google-gemini-flash'

beforeEach(registerFresh)

describe("settings:assignPrimaryModel — 'assistant-chat' is genuinely assignable", () => {
  it('persists a chain led by the picked model instead of silently no-opping', () => {
    const assign = ipcHandlers.get('settings:assignPrimaryModel')
    expect(assign).toBeDefined()

    const result = assign!({}, 'assistant-chat', REAL_CATALOG_ID) as { marker: string }

    expect(saveCalls).toHaveLength(1)
    const patch = saveCalls[0] as { aiModelAssignments: Record<string, { chain: string[] }> }
    expect(patch.aiModelAssignments['assistant-chat'].chain[0]).toBe(REAL_CATALOG_ID)
    // The handler returns the SAVED settings, not the untouched load —
    // returning the unchanged load is exactly how BUG-079 hid itself.
    expect(result.marker).toBe('saved-settings')
  })

  it("resetToAutomatic clears 'assistant-chat' back to an empty chain", () => {
    const reset = ipcHandlers.get('settings:resetToAutomatic')
    expect(reset).toBeDefined()

    const result = reset!({}, 'assistant-chat') as { marker: string }

    expect(saveCalls).toHaveLength(1)
    const patch = saveCalls[0] as { aiModelAssignments: Record<string, { chain: string[] }> }
    expect(patch.aiModelAssignments['assistant-chat'].chain).toEqual([])
    expect(result.marker).toBe('saved-settings')
  })

  it('control: an unknown purpose still no-ops (the guard itself works)', () => {
    const assign = ipcHandlers.get('settings:assignPrimaryModel')
    const result = assign!({}, 'not-a-real-purpose', REAL_CATALOG_ID) as { marker: string }

    expect(saveCalls).toHaveLength(0)
    expect(result.marker).toBe('unchanged-settings')
  })
})
