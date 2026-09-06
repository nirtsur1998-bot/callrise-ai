// BUG-192 (M35 Stage 2 walk) — the release page a stranger lands on. It used
// to say "Automated release vX." above six assets; Edge then blocked the
// unsigned installer as "Publisher: Unknown" with a three-click gauntlet, and
// nothing anywhere had told them which file to take or that the warning was
// expected. The release job now publishes .github/release-notes.md. These
// tests pin the wiring and the sentences a stranger needs.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const workflow = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
const notes = readFileSync(join(ROOT, '.github', 'release-notes.md'), 'utf8')

describe('release.yml publishes the notes file, not a one-liner', () => {
  it('creates the release with --notes-file from .github/release-notes.md, tag substituted', () => {
    expect(workflow).toMatch(/sed "s\/__TAG__\/\$TAG\/g" \.github\/release-notes\.md > \/tmp\/release-notes\.md/)
    expect(workflow).toMatch(/gh release create "\$TAG" --draft --title "\$TAG" --notes-file \/tmp\/release-notes\.md/)
    expect(workflow).not.toMatch(/--notes "Automated release/)
  })
})

describe('release-notes.md says what the walk showed a stranger needs', () => {
  it('carries the tag placeholder the job substitutes', () => {
    expect(notes).toContain('__TAG__')
  })
  it('names the one file to download, by its exact asset name', () => {
    expect(notes).toContain('`CallRise-AI-Windows.exe`')
    expect(notes).toMatch(/This is the one to take/)
  })
  it('walks the Edge SmartScreen block in the order Edge presents it', () => {
    const keep = notes.indexOf('**Keep**')
    const keepAnyway = notes.indexOf('**Keep anyway**')
    const open = notes.indexOf('**Open file**')
    expect(keep).toBeGreaterThan(-1)
    expect(keepAnyway).toBeGreaterThan(keep)
    expect(open).toBeGreaterThan(keepAnyway)
    expect(notes).toMatch(/isn't commonly downloaded/)
    expect(notes).toMatch(/not yet code-signed/)
  })
  it('warns about the silent first start (BUG-191) and the two keys (BUG-193)', () => {
    expect(notes).toMatch(/up to half a minute/)
    expect(notes).toMatch(/Deepgram/)
    expect(notes).toMatch(/AI provider/)
  })
})
