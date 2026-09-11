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
    expect(workflow).toMatch(
      /sed "s\/__TAG__\/\$TAG\/g" \.github\/release-notes\.md > \/tmp\/release-notes\.md/
    )
    expect(workflow).toMatch(
      /gh release create "\$TAG" --draft --title "\$TAG" --notes-file \/tmp\/release-notes\.md/
    )
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

describe('release-notes.md tells a user what M39 sends, and never goes stale', () => {
  it('says plainly that a matched contact’s history goes to the AI provider', () => {
    // The founder's sentence, 2026-09-11. Nothing inside the app describes the
    // client dossier, so this page is the one place a user can learn that a
    // buyer's earlier words now travel with every live cue — and there is no
    // switch for it yet (BUG-270). Pinned so an edit to the page cannot drop the
    // disclosure while keeping the feature.
    expect(notes).toMatch(
      /live coaching now includes what that contact has told you before, sent to your AI provider with the transcript/
    )
  })

  it('carries the real reach numbers, not an impression of them', () => {
    // "Put the real number in whatever the user sees. If it fires rarely, that's
    // honest; if I think it fires often and it doesn't, that's the inert-brain
    // problem again."
    expect(notes).toMatch(/30 of 50/)
    expect(notes).toMatch(/5 of 50/)
  })

  it('the "New in" section names the version actually being released', () => {
    // This file is a TEMPLATE, reused by every release. A version-specific
    // section would silently ship under the next tag describing the last one.
    // Tying the heading to package.json makes the next version bump fail here
    // until someone rewrites the section — which is the only moment anyone
    // would think to.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
    const heading = notes.match(/^### New in (\S+)$/m)
    expect(heading, 'release-notes.md must carry a "### New in <version>" section').not.toBeNull()
    expect(heading![1]).toBe(pkg.version)
  })
})
