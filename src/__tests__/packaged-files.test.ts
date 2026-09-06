// BUG-124 — the packaged app must not carry our build/test tooling.
//
// `electron-builder.yml`'s `files:` is a DENYLIST (every entry negates, so
// `**/*` is implied): anything not named is shipped. `scripts/` was not named
// and ~60 KB of it went to every user. This pins the exclusion; the fuller
// answer (an allowlist) is a Stage 3 item.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('electron-builder.yml files denylist', () => {
  const yml = readFileSync(join(__dirname, '..', '..', 'electron-builder.yml'), 'utf8')
  const files = yml.slice(yml.indexOf('\nfiles:'), yml.indexOf('\nextraResources:') > 0 ? yml.indexOf('\nextraResources:') : undefined)

  it('excludes scripts/ (BUG-124)', () => {
    expect(files).toMatch(/^\s*- '!scripts\/\*\*'/m)
  })

  it('still excludes the source, docs, supabase and .claude trees', () => {
    for (const entry of ["'!src/*'", "'!docs/**'", "'!supabase/**'", "'!.claude/**'"]) {
      expect(files, entry).toContain(entry)
    }
  })
})
