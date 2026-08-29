import { describe, it, expect } from 'vitest'
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSettingsGroups, ALERTS_BACKEND_LIVE } from '../settings-nav'

/**
 * M31 Stage 3 — "in Settings → X" must name a place that exists.
 *
 * The audit's finding was that every one of these landed on the wrong page,
 * because Settings always opened on Account. Stage 3 fixed the LANDING (see
 * settingsNav.ts). This guards the other half: that the words are true.
 *
 * They rot silently, and this milestone is why. Stage 5 renamed ten settings
 * pages and regrouped eleven groups into seven — so copy reading "Settings →
 * AI & coaching → Objection Library" now names a group that does not exist,
 * and nothing failed when it stopped being true. It is species 47's shape
 * exactly: an identifier matched by STRING against another module, where a
 * mismatch fails open and reads as perfectly normal prose.
 *
 * So this test consults the other module. It extracts every "Settings → …"
 * path out of the renderer's copy and checks each segment against the real
 * settings IA — both IAs, since the preview can be off.
 *
 * WHAT THIS DOES NOT DO: it cannot tell you the sentence is helpful, only
 * that the destination is real. A dead-end sentence with no button is still
 * a dead end; the fix for those is an EmptyState `off` reason, which carries
 * a working button by construction.
 */

const RENDERER = join(__dirname, '..', '..', '..')

/** Settings surfaces that belong to the OPERATING SYSTEM, not to us. These
 *  are correct as prose and must not be checked against our own page list. */
const OS_SETTINGS = [
  'Sound', // Windows: Settings → Sound
  'Privacy & Security', // macOS: System Settings → Privacy & Security
  'Notifications',
  'X' // MainApp's own comment describing the pattern generically
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/** Every "Settings → First segment" mention, with where it came from. */
function findSettingsPaths(): { file: string; segment: string; raw: string }[] {
  const found: { file: string; segment: string; raw: string }[] = []
  for (const file of walk(RENDERER)) {
    const src = readFileSync(file, 'utf8')
    // Tolerate the JSX-entity form (&amp;) and line breaks inside JSX text,
    // which is how most of these are actually written.
    const normalised = src.replace(/&amp;/g, '&').replace(/\s*\n\s*/g, ' ')
    for (const m of normalised.matchAll(/Settings\s*(?:→|->)\s*([A-Za-z0-9 &.'’-]+)/g)) {
      const segment = m[1].trim().replace(/[.,)]+$/, '')
      if (!segment) continue
      found.push({ file: file.slice(RENDERER.length + 1).replace(/\\/g, '/'), segment, raw: m[0] })
    }
  }
  return found
}

describe('"Settings → X" copy names a page that exists', () => {
  // Both IAs: the preview can be off, so a path must be valid in whichever
  // one the user is looking at. Checking only the new one would bless copy
  // that is wrong for everybody who has the preview turned off.
  //
  // The consequence, stated plainly because it is a real limit: copy naming
  // an OLD label ("Settings -> AI & coaching") passes today, since that group
  // still exists with the preview off. When the preview becomes permanent and
  // the legacy IA is deleted, this test turns red on every one of those —
  // which is the correct moment to fix them, and is exactly why the legacy
  // arrays should be deleted rather than left behind.
  //
  // Built with alerts LIVE deliberately, even though ALERTS_BACKEND_LIVE is
  // false today. The question this guard asks is "does this page EXIST", not
  // "is it currently visible" — the Alerts page is real code behind a
  // deployment flag (BUG-083), and flagging a reference to it would be a
  // false positive. Referenced here so the constant is not unused and the
  // choice is visible rather than incidental.
  void ALERTS_BACKEND_LIVE
  const labels = new Set<string>()
  for (const preview of [false, true]) {
    for (const group of buildSettingsGroups(true, preview)) {
      if (group.label) labels.add(group.label.toLowerCase())
      for (const item of group.items) labels.add(item.label.toLowerCase())
    }
  }

  const mentions = findSettingsPaths()

  it('finds mentions at all — otherwise this test is vacuous', () => {
    // Without this, a regex that stops matching (a copy rewrite, an entity
    // change) turns the whole guard green while checking nothing.
    expect(mentions.length, 'the extractor found no "Settings → X" copy at all').toBeGreaterThan(10)
  })

  it('names only real pages, groups, or OS settings', () => {
    const stale = mentions.filter((m) => {
      const seg = m.segment.toLowerCase()
      if (OS_SETTINGS.some((os) => seg.startsWith(os.toLowerCase()))) return false
      // A segment may be a page, a group, or a prefix of either (copy often
      // trails into a sentence: "Settings → CRM to change this").
      return ![...labels].some((label) => seg.startsWith(label) || label.startsWith(seg))
    })

    expect(
      stale.map((s) => `${s.file}: "${s.raw}"`),
      `these point at settings pages or groups that do not exist:\n  ` +
        stale.map((s) => `${s.file}: "${s.raw}"`).join('\n  ') +
        `\n\nReal labels: ${[...labels].sort().join(', ')}`
    ).toEqual([])
  })
})
