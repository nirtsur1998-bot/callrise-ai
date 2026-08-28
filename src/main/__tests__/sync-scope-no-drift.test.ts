// BUG-091 — the Sales Brain cloud backup had no UI switch, so upload AND
// restore were unreachable from the product and three "fixed" bugs
// (BUG-087/088/089) lived in code nothing could call.
//
// Root cause: BackupCard hand-wrote a five-key `SyncScopeKey` union while main
// declared six. An independent copy cannot disagree loudly, so TypeScript saw
// nothing. The renderer is now `keyof BackupSyncScope` (a compile error if that
// hop drifts) — but the type reaches the renderer through preload/index.d.ts,
// which RE-DECLARES the interface. Types alone therefore cannot cover the
// main <-> preload hop; this file does, at runtime, against the real objects.
//
// Founder's framing, and the reason this is a test rather than a convention:
// "ask who WRITES the field, not whether the types match." A sole-writer type
// that drifts silently deletes a feature.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: vi.fn() } }))

/** Field names of an `export interface X { … }` block, read from source. */
function interfaceKeys(file: string, name: string): string[] {
  const text = readFileSync(file, 'utf8')
  const start = text.indexOf(`export interface ${name} {`)
  if (start < 0) throw new Error(`${name} not found in ${file}`)
  let depth = 0
  let end = start
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = text.slice(start, end)
  return [...body.matchAll(/^\s{2}(\w+)\??\s*:/gm)].map((m) => m[1]).sort()
}

const ROOT = join(__dirname, '..', '..', '..')

describe('BUG-091 — syncScope must not drift across the three declarations', () => {
  it('preload re-declares BackupSyncScope with exactly main’s keys', async () => {
    const mod = await import('../app-settings')
    const live = Object.keys(mod.loadAppSettings().syncScope).sort()
    const preload = interfaceKeys(join(ROOT, 'src', 'preload', 'index.d.ts'), 'BackupSyncScope')

    expect(live.length).toBeGreaterThanOrEqual(6) // non-vacuity: we really read a scope
    expect(preload, 'preload/index.d.ts disagrees with main').toEqual(live)
    expect(live).toContain('salesBrain') // the key whose absence caused BUG-091
  })

  it('the Backup card offers a toggle for every optional scope key', () => {
    const card = readFileSync(
      join(ROOT, 'src', 'renderer', 'src', 'features', 'backup', 'BackupCard.tsx'),
      'utf8'
    )
    // OPTIONAL_ITEMS' key list, read from source rather than imported (the
    // component pulls in the whole renderer graph).
    const offered = [...card.matchAll(/\{\s*key:\s*'(\w+)',/g)].map((m) => m[1]).sort()
    const preload = interfaceKeys(join(ROOT, 'src', 'preload', 'index.d.ts'), 'BackupSyncScope')

    expect(offered.length).toBeGreaterThanOrEqual(6) // non-vacuity
    expect(
      offered,
      'a scope key with no UI row has no writer — the flag can never be turned on'
    ).toEqual(preload)
  })

  it('the renderer DERIVES its key union rather than retyping it', () => {
    const card = readFileSync(
      join(ROOT, 'src', 'renderer', 'src', 'features', 'backup', 'BackupCard.tsx'),
      'utf8'
    )
    expect(card).toContain('type SyncScopeKey = keyof BackupSyncScope')
    // The literal union is what allowed the drift; it must not come back.
    expect(card).not.toMatch(/type SyncScopeKey\s*=\s*\n?\s*'transcripts'/)
  })
})
