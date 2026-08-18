// M27 J3 — better-sqlite3 and sqlite-vec must never be loaded at module
// scope anywhere in src/main. Both are native modules; a top-level (eager)
// import means every user's process loads them at startup, whether or not
// Sales Brain is even enabled — the exact pattern that (via a different
// native module, onnxruntime-node) shipped Sales Brain completely dead on
// clean Windows machines across three separate hotfixes (1.2.1/1.2.3/1.2.4).
// embeddings.ts's loadTransformers() and WindowsAdapter.ts's
// loadNativeAddon() already established the fix pattern (require() or a
// dynamic import() inside a function body, not a top-level import) for
// their own native modules; db.ts and diagnose.ts now follow it too.
//
// This is a STRUCTURAL claim (what the import graph looks like), not a
// runtime-behavior one — a require.cache inspection would be unreliable in
// a Vitest process where other test files may import these packages
// directly for their own purposes, which would already have loaded them
// before this test's body ever runs. A source scan is the honest way to pin
// this specific property. Comments are stripped first so a stray mention
// (a doc comment explaining the lazy-load fix, like this file's own) can't
// satisfy the check the way species 2 of the hollow-green taxonomy warns
// about — this scans real import statements, not text that merely contains
// the package name.
//
// Deliberately whole-tree, not scoped to db.ts alone: this exact class of
// gap was found once already this session in diagnose.ts, a completely
// different file, discovered only by inspecting the compiled bundle after
// db.ts's own fix looked complete. A repo-wide scan is what would have
// caught it directly.
import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const NATIVE_MODULES = ['better-sqlite3', 'sqlite-vec']
const SRC_MAIN = fileURLToPath(new URL('../../', import.meta.url))

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listTsFiles(full)))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('M27 J3 — no eager top-level import of a native module anywhere in src/main', () => {
  it('every .ts file (excluding tests) only ever imports better-sqlite3/sqlite-vec as a type, or inside a function body', async () => {
    const files = await listTsFiles(SRC_MAIN)
    expect(files.length).toBeGreaterThan(50) // sanity check the walk actually found real source

    const offenders: string[] = []
    for (const file of files) {
      const raw = await readFile(file, 'utf8')
      const withoutComments = raw
        .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
        .replace(/\/\/.*$/gm, '') // line comments
      for (const line of withoutComments.split('\n')) {
        if (!/^\s*import\b/.test(line)) continue // only top-level import statements — a require() inside a function is fine
        const isTypeOnly = /^\s*import\s+type\b/.test(line)
        if (isTypeOnly) continue
        for (const mod of NATIVE_MODULES) {
          if (new RegExp(`['"]${mod}['"]`).test(line)) {
            offenders.push(`${file.replace(dirname(SRC_MAIN), '')}: ${line.trim()}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
