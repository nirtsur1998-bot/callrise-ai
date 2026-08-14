// The bug that made Sales Brain completely dead in every packaged build:
// sqlite-vec resolves vec0.dll with require.resolve, which inside a packaged
// app returns a path INSIDE app.asar. loadExtension() passes that straight to
// SQLite's C sqlite3_load_extension -> LoadLibraryW, which cannot read an asar
// archive and fails with ERROR_MOD_NOT_FOUND ("The specified module could not
// be found").
//
// What hid it for four releases: existsSync() reports the asar path as TRUE
// (Electron's fs shim fakes it), so every "is the file there?" check passed
// while the file was genuinely unloadable by the OS loader. Reproduced
// end-to-end against a real packaged build before this fix was written:
// loadExtension on the raw path failed with that exact message, on the
// corrected path it returned vec_version v0.1.9.
import { describe, expect, it, vi } from 'vitest'

const existing = new Set<string>()
vi.mock('node:fs', () => ({
  existsSync: (p: string) => existing.has(p),
  copyFileSync: () => {},
  rmSync: () => {}
}))
vi.mock('better-sqlite3', () => ({ default: class {} }))
vi.mock('sqlite-vec', () => ({ getLoadablePath: () => '', load: () => {} }))

const { resolveVecExtensionPath } = await import('../db')

const WIN_RAW = ['C:', 'app', 'resources', 'app.asar', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'].join('\\')
const WIN_UNPACKED = ['C:', 'app', 'resources', 'app.asar.unpacked', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'].join('\\')

describe('resolveVecExtensionPath', () => {
  it('redirects an app.asar path to the unpacked copy the OS loader can actually open', () => {
    existing.clear()
    existing.add(WIN_UNPACKED)
    expect(resolveVecExtensionPath(WIN_RAW)).toBe(WIN_UNPACKED)
  })

  it('handles posix separators too', () => {
    const raw = '/app/resources/app.asar/node_modules/sqlite-vec-linux-x64/vec0.so'
    const unpacked = '/app/resources/app.asar.unpacked/node_modules/sqlite-vec-linux-x64/vec0.so'
    existing.clear()
    existing.add(unpacked)
    expect(resolveVecExtensionPath(raw)).toBe(unpacked)
  })

  it('is a no-op in dev, where there is no app.asar segment at all', () => {
    const raw = ['C:', 'repo', 'node_modules', 'sqlite-vec-windows-x64', 'vec0.dll'].join('\\')
    existing.clear()
    existing.add(raw)
    expect(resolveVecExtensionPath(raw)).toBe(raw)
  })

  it('falls back to the original when no unpacked copy exists — never invents a path', () => {
    existing.clear() // nothing on disk
    expect(resolveVecExtensionPath(WIN_RAW)).toBe(WIN_RAW)
  })
})
