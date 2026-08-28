// Cutover 2026-08-28 — the Supabase project changed, which signs every
// existing install out. The app therefore shows a one-time card explaining
// that the data is safe and the account must be created again with the same
// email. Drives the REAL loadAppSettings()/saveAppSettings() against a real
// temp file, same pattern as app-settings-auto-update-migration.test.ts.
//
// THE TWO WAYS THIS GOES WRONG, and both are asserted below:
//
//   1. The notice DOESN'T fire for an install that predates the cutover. That
//      user is signed out with no explanation, and the honest reading of the
//      screen is "my account and all my calls are gone" — which is false, and
//      is the most alarming thing this app could say.
//
//   2. The notice DOES fire for a brand-new install. That user never had an
//      account on the old project, so "sign in again with the same email" is a
//      lie, and "don't press Sign out" is advice about a risk they don't have.
//
// A single boolean cannot distinguish those two, which is why the marker
// (accountMigratedToNewProject) exists separately from the notice flag: the
// marker records "this install has been through the cutover", and only its
// ABSENCE on a settings file that ALREADY EXISTS means "predates the cutover".
//
// Red-checked: making the load path set accountMigrationNoticePending from the
// stored value regardless of the marker turns the upgrade test red while the
// fresh-install test stays green — proving the tests discriminate the
// migration specifically rather than just reading back a default.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let dir: string

vi.mock('electron', () => ({ app: { getPath: () => dir } }))

async function freshModule(): Promise<typeof import('../app-settings')> {
  vi.resetModules()
  return import('../app-settings')
}

/** A settings file as it exists on an install from BEFORE the cutover: real
 *  fields, and no accountMigratedToNewProject marker anywhere. */
function writePreCutoverFile(): void {
  writeFileSync(
    join(dir, 'app-settings.json'),
    JSON.stringify({
      autoUpdateEnabled: true,
      autoUpdateMigratedToDefaultOn: true,
      autoUpdateNoticePending: false
    }),
    'utf8'
  )
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cutover-migration-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the cutover notice fires for upgrades and never for fresh installs', () => {
  it('an install that predates the cutover gets the notice, and is marked', async () => {
    writePreCutoverFile()
    const { loadAppSettings } = await freshModule()
    const s = loadAppSettings()
    expect(
      s.accountMigrationNoticePending,
      'a signed-out user would get no explanation at all'
    ).toBe(true)
    expect(s.accountMigratedToNewProject).toBe(true)
  })

  it('a BRAND-NEW install does NOT get it — it never had an old account', async () => {
    // No settings file at all: the defaults path, not the migration path.
    const { loadAppSettings } = await freshModule()
    const s = loadAppSettings()
    expect(
      s.accountMigrationNoticePending,
      'a fresh install was told to "sign in again with the same email" — a lie'
    ).toBe(false)
    expect(s.accountMigratedToNewProject).toBe(true)
  })

  it('dismissing persists and the card never resurrects', async () => {
    writePreCutoverFile()
    const first = await freshModule()
    expect(first.loadAppSettings().accountMigrationNoticePending).toBe(true) // control
    first.saveAppSettings({ accountMigrationNoticePending: false })

    const onDisk = JSON.parse(readFileSync(join(dir, 'app-settings.json'), 'utf8'))
    expect(onDisk.accountMigratedToNewProject, 'the marker must persist too').toBe(true)

    const second = await freshModule()
    expect(
      second.loadAppSettings().accountMigrationNoticePending,
      'the card came back after being dismissed'
    ).toBe(false)
  })

  it('an already-migrated file is left alone', async () => {
    writeFileSync(
      join(dir, 'app-settings.json'),
      JSON.stringify({
        accountMigratedToNewProject: true,
        accountMigrationNoticePending: false
      }),
      'utf8'
    )
    const { loadAppSettings } = await freshModule()
    expect(loadAppSettings().accountMigrationNoticePending).toBe(false)
  })
})

describe('a cloud pull cannot move the cutover flags — they are per-install facts', () => {
  // Same invariant as autoUpdateEnabled/autoUpdateMigratedToDefaultOn (M29
  // sweep item 5): the pushed payload is the WHOLE settings object, so it
  // always carries a value for these, and settings sync would otherwise
  // teleport one machine's migration history onto another.

  it('a FRESH install cannot be handed another machine\'s pending notice', async () => {
    const mod = await freshModule() // no file => fresh install, notice false
    expect(mod.loadAppSettings().accountMigrationNoticePending).toBe(false) // control

    // A pre-cutover machine migrated and pushed its whole settings object.
    const next = mod.applyPulledSettings(
      { accountMigratedToNewProject: true, accountMigrationNoticePending: true },
      new Date(Date.now() + 60_000).toISOString()
    )
    expect(
      next.accountMigrationNoticePending,
      'a fresh install was shown the upgrade notice via settings sync'
    ).toBe(false)

    const reloaded = await freshModule()
    expect(reloaded.loadAppSettings().accountMigrationNoticePending).toBe(false) // and it stuck
  })

  it('a second pre-cutover machine keeps its notice despite a dismissed pull', async () => {
    writePreCutoverFile()
    const mod = await freshModule()
    expect(mod.loadAppSettings().accountMigrationNoticePending).toBe(true) // control

    // The first machine already dismissed the card and pushed.
    const next = mod.applyPulledSettings(
      { accountMigratedToNewProject: true, accountMigrationNoticePending: false },
      new Date(Date.now() + 60_000).toISOString()
    )
    expect(
      next.accountMigrationNoticePending,
      'this machine is signed out with no explanation on screen'
    ).toBe(true)
  })

  it('the local dismiss still works — the pin must not freeze the flag', async () => {
    writePreCutoverFile()
    const mod = await freshModule()
    mod.saveAppSettings({ accountMigrationNoticePending: false })
    expect(mod.loadAppSettings().accountMigrationNoticePending).toBe(false)
  })
})

describe('the build actually points at the new project', () => {
  it('SUPABASE_URL is the new ref, not the old one', async () => {
    const src = readFileSync(join(__dirname, '..', 'default-config.ts'), 'utf8')
    const urlLine = src.split('\n').find((l) => l.trim().startsWith('SUPABASE_URL:'))
    expect(urlLine, 'no SUPABASE_URL line found').toBeTruthy()
    expect(urlLine).toContain('emsbcxwzbjttxpimvlnj.supabase.co')
    // Asserted on the CONFIG LINE, not on the file: the old ref legitimately
    // still appears in the comment explaining the 30-day parachute.
    expect(urlLine, 'SUPABASE_URL still points at the old project').not.toContain(
      'fphvsuvpskqwkcpiocfz'
    )
  })

  it('the anon key belongs to the new project, not the old one', async () => {
    const src = readFileSync(join(__dirname, '..', 'default-config.ts'), 'utf8')
    // Matched across a possible line wrap: prettier puts the key literal on
    // its own line, so a line-oriented search finds the label and no value.
    const jwt = src.match(
      /SUPABASE_ANON_KEY:\s*'([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'/
    )?.[1]
    expect(jwt, 'could not read the key literal').toBeTruthy()
    // A JWT's middle segment is base64url of a claims blob containing
    // "ref":"<project>". Decoding it proves the key and the URL agree — a
    // mismatched pair is the one config error that fails only at runtime,
    // for every user at once, with an opaque auth error.
    const claims = JSON.parse(Buffer.from(jwt!.split('.')[1], 'base64url').toString('utf8'))
    expect(claims.ref, 'the anon key is for a DIFFERENT project than SUPABASE_URL').toBe(
      'emsbcxwzbjttxpimvlnj'
    )
    expect(claims.role).toBe('anon')
  })
})
