import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadDesignPreview,
  saveDesignPreview,
  DESIGN_PREVIEW_KEY,
  LEGACY_PREVIEW_KEYS
} from '../designPreview'

/**
 * M31 — the four preview flags collapsed into one.
 *
 * The founder's condition, and the reason most of this file exists: *"one
 * switch means one failure mode: if turning it off leaves any part of the new
 * design behind, that's worse than four switches. Prove the off state is
 * byte-identical to what ships today."*
 *
 * So two things are pinned here. That the MIGRATION cannot silently re-enable
 * something a user turned off — it runs once per person and a wrong answer is
 * invisible afterwards. And that no surface still reads a flag of its own,
 * which is the only way "off" can be partial.
 */

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()
  // A minimal localStorage. Deliberately not a mock of the module under test:
  // the migration IS localStorage reads, so faking those would test nothing.
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    }
  } as Storage
})

afterEach(() => {
  // @ts-expect-error — putting the environment back as it was found
  delete globalThis.localStorage
})

describe('the single switch', () => {
  it('defaults ON for a brand-new install', () => {
    expect(loadDesignPreview()).toBe(true)
  })

  it('round-trips an explicit choice, and OFF survives', () => {
    saveDesignPreview(false)
    expect(loadDesignPreview()).toBe(false)
    saveDesignPreview(true)
    expect(loadDesignPreview()).toBe(true)
  })

  it('never throws when localStorage is unavailable', () => {
    // @ts-expect-error — a private window, or a context that blocks site data
    delete globalThis.localStorage
    expect(() => loadDesignPreview()).not.toThrow()
    expect(() => saveDesignPreview(true)).not.toThrow()
  })
})

describe('migration from the four flags it replaces', () => {
  it('honours an explicit OFF on ANY of them', () => {
    // The load-bearing one. Collapsing four switches into one must not
    // quietly turn back on something a person deliberately rejected — they
    // would have no way to know it happened.
    for (const legacy of LEGACY_PREVIEW_KEYS) {
      store.clear()
      store.set(legacy, 'false')
      expect(loadDesignPreview(), `${legacy}=false was ignored`).toBe(false)
    }
  })

  it('is not "on if any was on" — the cautious choice wins over the keen one', () => {
    store.set('salesos.navigation.preview', 'true')
    store.set('salesos.calendar.preview', 'false')
    expect(loadDesignPreview()).toBe(false)
  })

  it('gives the new design to anyone who never touched them, or turned them on', () => {
    expect(loadDesignPreview()).toBe(true)
    store.clear()
    for (const legacy of LEGACY_PREVIEW_KEYS) store.set(legacy, 'true')
    expect(loadDesignPreview()).toBe(true)
  })

  it('lets an explicit choice on the NEW key override the migration entirely', () => {
    // Once someone has answered the combined question, the old flags are
    // history and must stop influencing anything.
    store.set('salesos.navigation.preview', 'false')
    store.set(DESIGN_PREVIEW_KEY, 'true')
    expect(loadDesignPreview()).toBe(true)
  })
})

describe('off is complete — no surface keeps a flag of its own', () => {
  const RENDERER = join(__dirname, '..', '..', '..')

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, out)
      else if (/\.tsx?$/.test(entry)) out.push(full)
    }
    return out
  }

  it('no code reads any of the retired preview keys', () => {
    // This is what makes "one failure mode" true rather than intended. A
    // surface still reading its own key would produce a half-reverted app —
    // a new sidebar with the old palette — which is the exact state the
    // founder said would be worse than four switches.
    const offenders: string[] = []
    for (const file of walk(RENDERER)) {
      const src = readFileSync(file, 'utf8')
      for (const key of LEGACY_PREVIEW_KEYS) {
        // The keys are named in designPreview.ts's own migration list, which
        // is the one legitimate reader.
        if (src.includes(`'${key}'`) && !file.endsWith('designPreview.ts')) {
          offenders.push(`${file.slice(RENDERER.length + 1).replace(/\\/g, '/')} reads ${key}`)
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('the retired hooks are gone, not merely unused', () => {
    // Left in place they would be an invitation: the next person adds a
    // stage, finds useNavigationPreview, and the app has two switches again.
    const files = walk(RENDERER).map((f) => f.replace(/\\/g, '/'))
    for (const gone of [
      'navigation/useNavigationPreview.ts',
      'navigation/navigationPreview.ts',
      'calendar/useCalendarPreview.ts',
      'calendar/calendarPreview.ts',
      'settings/useIdentityPreview.ts',
      'settings/identityPreview.ts',
      'settings/useSettingsPreview.ts',
      'settings/settingsPreview.ts'
    ]) {
      expect(
        files.some((f) => f.endsWith(gone)),
        `${gone} still exists — a second switch waiting to be re-adopted`
      ).toBe(false)
    }
  })
})
