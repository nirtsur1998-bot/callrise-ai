// BUG-095's species, applied to settings (founder's follow-up, 2026-08-24).
//
// `loadAppSettings` and `mergeSettings` both rebuild AppSettings as a CLOSED
// OBJECT LITERAL with no spread of the source. That is the exact shape that
// lost CRM comments for a whole feature's lifetime: a field added to the type
// but not to the literal is dropped silently, and because saveAppSettings is
// read-merge-write, the drop is destructive — saving ANY unrelated setting
// wipes the missing one off disk.
//
// The audit found mergeSettings currently lists all 24 fields, so there is no
// live defect. That is completeness BY LUCK, not by construction — this file
// makes it structural:
//
//   * the fixture is typed `AppSettings`, and all 24 fields are required, so
//     TypeScript REFUSES TO COMPILE this file the moment a field is added to
//     the type until the fixture sets it;
//   * every value is deliberately NON-DEFAULT, so a dropped field comes back
//     as its default and the comparison fails (a fixture full of defaults
//     could not tell "preserved" from "silently reset");
//   * the assertion is a FRESH READ after an unrelated save, never the return
//     value of the call that wrote it — the BUG-095 lesson.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string

vi.mock('electron', () => ({ app: { getPath: () => dir }, ipcMain: { handle: vi.fn() } }))

async function freshModule(): Promise<typeof import('../app-settings')> {
  vi.resetModules()
  return import('../app-settings')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-nodrop-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('no AppSettings field may be silently dropped by load or merge', () => {
  it('every field survives a fresh read after an unrelated save', async () => {
    const mod = await freshModule()
    const base = mod.loadAppSettings()

    // Typed AppSettings => TypeScript forces every one of the 24 fields to be
    // present here. Nested objects are spread from the default with one leaf
    // deliberately changed, so a whole nested field being dropped is visible.
    const FULL: import('../app-settings').AppSettings = {
      allowOtherPartyRecording: false, // default true
      alwaysRecordOtherParty: true, // default false
      personalization: { ...base.personalization, role: 'Head of Sales' },
      summaryLanguage: 'english', // default 'auto'
      syncScope: { ...base.syncScope, transcripts: true, salesBrain: true },
      settingsUpdatedAt: '2026-08-24T12:00:00.000Z',
      googleCalendarConnected: true,
      outlookCalendarConnected: true,
      crm: { ...base.crm, autoGenerateNotes: !base.crm.autoGenerateNotes },
      objectionMining: { ...base.objectionMining, enabled: !base.objectionMining.enabled },
      detection: { ...base.detection, enabled: !base.detection.enabled },
      speakerId: { ...base.speakerId, enabled: !base.speakerId.enabled },
      aiProvider: 'google', // default 'anthropic'
      aiModelAssignments: { ...base.aiModelAssignments, summary: { chain: ['google-gemini-2.5-pro'] } },
      autoUpdateEnabled: false, // default true
      autoUpdateMigratedToDefaultOn: true,
      autoUpdateNoticePending: false, // default true
      coach2: { ...base.coach2, enabled: !base.coach2.enabled },
      contactIntelligence: { ...base.contactIntelligence, mode: 'full-auto' },
      salesBrain: { ...base.salesBrain, enabled: !base.salesBrain.enabled },
      dealIntelligence: { ...base.dealIntelligence, enabled: !base.dealIntelligence.enabled },
      liveCues: { ...base.liveCues, enabled: !base.liveCues.enabled },
      jobConcurrency: { ...base.jobConcurrency, batch: 7 },
      jobNotifications: {
        ...base.jobNotifications,
        nativeEnabled: !base.jobNotifications.nativeEnabled
      }
    }

    // Seed disk with the fully-populated record, then reload.
    writeFileSync(join(dir, 'app-settings.json'), JSON.stringify(FULL), 'utf8')
    const reloaded = await freshModule()
    const afterLoad = reloaded.loadAppSettings()

    // 1. loadAppSettings' own closed literal must not drop anything.
    for (const key of Object.keys(FULL) as (keyof typeof FULL)[]) {
      if (key === 'settingsUpdatedAt') continue // restamped on save; checked below
      expect(afterLoad[key], `loadAppSettings dropped "${key}"`).toEqual(FULL[key])
    }

    // 2. Now save ONE unrelated field. This runs mergeSettings, which is
    //    read-merge-write — the destructive half of the BUG-095 shape.
    reloaded.saveAppSettings({ googleCalendarConnected: false })

    // 3. FRESH READ from disk, in a new module instance: no in-memory state,
    //    exactly what reopening the app does.
    const after = await freshModule()
    const finalState = after.loadAppSettings()

    expect(finalState.googleCalendarConnected).toBe(false) // the edit landed
    for (const key of Object.keys(FULL) as (keyof typeof FULL)[]) {
      if (key === 'googleCalendarConnected') continue // the field we changed
      if (key === 'settingsUpdatedAt') continue // restamped by the writer, by design
      expect(finalState[key], `saving an unrelated field wiped "${key}"`).toEqual(FULL[key])
    }

    // settingsUpdatedAt is the backup ordering key and MUST move on a save.
    expect(typeof finalState.settingsUpdatedAt).toBe('string')
    expect(finalState.settingsUpdatedAt).not.toBe(FULL.settingsUpdatedAt)
  })

  it('the seeded file really held non-default values (the control)', async () => {
    // Without this, a fixture that accidentally matched the defaults would make
    // the test above pass while proving nothing.
    const mod = await freshModule()
    const defaults = mod.loadAppSettings()
    expect(defaults.allowOtherPartyRecording).toBe(true)
    expect(defaults.autoUpdateEnabled).toBe(true)
    expect(defaults.aiProvider).toBe('anthropic')
    expect(defaults.summaryLanguage).toBe('auto')
    // Each of these is flipped by the fixture above, so a dropped field comes
    // back as the default shown here and the comparison fails. If any default
    // ever changes to match the fixture, this control goes red first.
  })
})
