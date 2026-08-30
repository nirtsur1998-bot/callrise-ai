import { describe, expect, it, vi } from 'vitest'

// platform.ts reads window.electron.process at MODULE LOAD — correct for a
// sandboxed renderer, fatal in a node test. Mocked to WINDOWS deliberately:
// the bug this file exists for was a Mac glyph printed on Windows, so the
// platform under test should be the one that was getting it wrong.
vi.mock('@renderer/lib/platform', () => ({ isMac: false, isWindows: true }))
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHORTCUTS, shortcutGroups, shortcutKeys, shortcutLabel } from '../shortcuts'

/**
 * The registry describes what exists. These tests check that description
 * against the code that actually registers the keys — in BOTH processes,
 * because two of the shortcuts are global and live in main.
 *
 * Without this, the registry is just a fourth hand-written list. It replaced
 * three that had already drifted:
 *   • the overlay printed `⌘⇧S` on Windows, where main registers Ctrl
 *   • palette and overlay both said ⌘⇧L "Start a live call"; it navigates
 *   • the detection keys were advertised as always-on but are registered
 *     with tray presence
 */

const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const strip = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

describe('the registry is the only display list', () => {
  it('the overlay renders from it and keeps no list of its own', () => {
    const overlay = strip(read('src/renderer/src/features/navigation/ShortcutsOverlay.tsx'))
    expect(overlay).toContain('shortcutGroups(')
    // The shape of the old copy: an inline array of {label, keys} literals.
    expect(overlay, 'the overlay has grown its own list again').not.toMatch(/keys:\s*['"`]/)
  })

  it('palette actions take their label and keys from it', () => {
    const main = strip(read('src/renderer/src/app/MainApp.tsx'))
    const actions = main.slice(main.indexOf('paletteActions'), main.indexOf('const onKey'))
    expect(actions).toContain('shortcutKeys(')
    expect(actions).toContain('shortcutLabel(')
    // No hand-typed modifier strings left anywhere in the action list.
    expect(actions, 'a shortcut string is hardcoded again').not.toMatch(/['"`](⌘|Ctrl )/)
  })
})

describe('every advertised key is actually registered', () => {
  const mainApp = strip(read('src/renderer/src/app/MainApp.tsx'))
  const detection = strip(read('src/main/detection-overlay.ts'))

  // Registry id -> the evidence that a handler exists for it.
  const RENDERER_BINDINGS: Record<string, RegExp> = {
    palette: /key\.toLowerCase\(\) === 'k'/,
    'live-call': /shiftKey && e\.key\.toLowerCase\(\) === 'l'/,
    'new-event': /shiftKey && e\.key\.toLowerCase\(\) === 'e'/,
    'toggle-theme': /shiftKey && e\.key\.toLowerCase\(\) === 't'/,
    'nav-digits': /\/\^\[1-9\]\$\/\.test\(e\.key\)/,
    help: /e\.key !== '\?'/
  }

  const MAIN_BINDINGS: Record<string, RegExp> = {
    'detection-stop': /globalShortcut\.register\('CommandOrControl\+Shift\+S'/,
    'detection-pause': /globalShortcut\.register\('CommandOrControl\+Shift\+P'/
  }

  it.each(Object.keys(RENDERER_BINDINGS))('%s has a renderer handler', (id) => {
    expect(SHORTCUTS.some((s) => s.id === id), `${id} left the registry`).toBe(true)
    expect(mainApp, `${id} is advertised but nothing handles it`).toMatch(RENDERER_BINDINGS[id])
  })

  it.each(Object.keys(MAIN_BINDINGS))('%s is registered in main', (id) => {
    expect(SHORTCUTS.some((s) => s.id === id), `${id} left the registry`).toBe(true)
    expect(detection, `${id} is advertised but main does not register it`).toMatch(
      MAIN_BINDINGS[id]
    )
  })

  it('nothing is advertised that has no known binding', () => {
    // Palette-internal keys (arrows, enter, escape) and the generic Esc are
    // handled by the palette/Modal components rather than a global listener,
    // so they are named here rather than left to slip through unchecked.
    const COMPONENT_LEVEL = new Set(['palette-move', 'palette-open', 'palette-close', 'esc'])
    const unaccounted = SHORTCUTS.map((s) => s.id).filter(
      (id) => !RENDERER_BINDINGS[id] && !MAIN_BINDINGS[id] && !COMPONENT_LEVEL.has(id)
    )
    expect(
      unaccounted,
      'these are shown to the user with no evidence a handler exists — add the binding, or the evidence'
    ).toEqual([])
  })
})

describe('the platform bug cannot come back', () => {
  it('no shortcut hardcodes a Mac glyph', () => {
    // The exact defect: one group printed ⌘ while main registers
    // CommandOrControl, so Windows users were told to press a key that does
    // not exist on their keyboard.
    const src = strip(read('src/renderer/src/features/navigation/shortcuts.ts'))
    const literals = [...src.matchAll(/keys:\s*[`'"]([^`'"]*)[`'"]/g)].map((m) => m[1])
    const hardcoded = literals.filter((k) => k.includes('⌘'))
    expect(hardcoded, 'these print ⌘ regardless of platform — use MOD').toEqual([])
  })

  it('every modifier shortcut resolves through MOD', () => {
    // On this test runner isMac is false, so anything modifier-based must
    // render as Ctrl. If a ⌘ appears, something bypassed MOD.
    const withGlyph = SHORTCUTS.filter((s) => s.keys.includes('⌘'))
    expect(withGlyph.map((s) => s.id)).toEqual([])
  })
})

describe('the sheet never advertises an unregistered binding', () => {
  it('hides the digit shortcuts when the preview nav is off', () => {
    // MainApp only registers ⌘1-9 while the preview nav is on.
    const off = shortcutGroups(false).flatMap((g) => g.shortcuts.map((s) => s.id))
    const on = shortcutGroups(true).flatMap((g) => g.shortcuts.map((s) => s.id))
    expect(off).not.toContain('nav-digits')
    expect(on).toContain('nav-digits')
  })

  it('tells the truth about when the detection keys work', () => {
    // They are registered alongside tray presence, not at boot. The old title
    // said "works even when CallRise AI is in the background", which reads as
    // always-on and was the Stage 0 audit's copy-drift finding.
    const detection = shortcutGroups(true).find((g) => g.id === 'detection')!
    expect(detection.title).toMatch(/while detection is running/i)
  })
})

describe('lookups fail loudly', () => {
  it('throws on an unknown id rather than rendering a blank hint', () => {
    expect(() => shortcutKeys('nope')).toThrow(/unknown shortcut id/)
    expect(() => shortcutLabel('nope')).toThrow(/unknown shortcut id/)
  })
})
