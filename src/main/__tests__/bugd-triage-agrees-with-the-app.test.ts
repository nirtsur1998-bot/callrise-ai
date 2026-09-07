// M37 Stage 2 — the BUG-D triage instrument must not drift from the app.
//
// scripts/verification/bugd-triage.mjs decides whether a call's missing words
// are explained by capture failing or by something downstream. To do that it
// needs one rule the SHIPPED app also holds: the date from which the absence
// of a channel means anything (CHANNEL_ATTRIBUTION_SINCE). The instrument
// cannot import the renderer's module (it runs as a plain script over JSON
// files on any machine, with no build step), so it carries a copy — and a
// copy of a rule goes stale silently, which is species 16 on this project and
// has already cost it once.
//
// This is the cheapest possible guard: if the shipped constant moves and the
// instrument's does not, the suite says so by name. The sibling
// bugd-partition.mjs carries the same warning in its header and has no such
// test; it is left alone here rather than half-fixed.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..')

// The app's constant is READ FROM ITS SOURCE rather than imported. Importing
// it pulls a renderer module into a main-process test, and the renderer's own
// `@renderer/...` path alias is not resolvable from the node tsconfig — the
// first version of this file failed typecheck with
// "Cannot find module '@renderer/features/coaching/types'", a transitive import
// of the file it wanted one string from. Reading the source is also closer to
// what this test is actually asserting: that two files agree textually.
function appConstant(): string {
  const src = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'features', 'calls', 'types.ts'), 'utf8')
  const m = /export const CHANNEL_ATTRIBUTION_SINCE = '([\d-]+)'/.exec(src)
  if (!m) throw new Error('the app no longer declares CHANNEL_ATTRIBUTION_SINCE in calls/types.ts')
  return m[1]
}

describe('bugd-triage.mjs mirrors the app', () => {
  it('carries the same CHANNEL_ATTRIBUTION_SINCE the shipped app uses', () => {
    const app = appConstant()
    const src = readFileSync(join(ROOT, 'scripts', 'verification', 'bugd-triage.mjs'), 'utf8')
    const m = /export const CHANNEL_ATTRIBUTION_SINCE = '([\d-]+)'/.exec(src)
    expect(m, 'the instrument no longer declares CHANNEL_ATTRIBUTION_SINCE — did it get renamed?').not.toBeNull()
    expect(
      m?.[1],
      `the app says ${app}, the triage instrument says ${m?.[1]}. ` +
        'One of them is wrong about which calls can be judged; update scripts/verification/bugd-triage.mjs.'
    ).toBe(app)
  })

  it('the collector writes ONLY the fields on an allowlist — a denylist was not enough', () => {
    // REWRITTEN after an adversarial audit defeated the first version, M37.
    //
    // The first version was a DENYLIST: it flagged an assignment whose value
    // read $c.text / .title / .summary / .coaching / .preview / .notes. An
    // audit agent was asked to find a leak it would miss and found three in
    // one attempt — it added `speakerIdentities = $c.speakerIdentities`
    // (people's names), `commitments = $c.commitments` and
    // `bookmarks = $c.bookmarks` (transcript excerpts), and the test stayed
    // green on all three while catching only the fourth. A denylist of the
    // field names someone happened to think of cannot fail on the field
    // nobody thought of, which is this project's own rule about absence tests
    // and the reason CALL_FIELD_RULES is exhaustive over Required<Call>
    // rather than a list of the dangerous fields.
    //
    // So: an ALLOWLIST of the exact key=value pairs the collector may write.
    // Anything else — any new field, however innocent-looking — fails here
    // and has to be justified by editing this list.
    const ps = readFileSync(join(ROOT, 'scripts', 'verification', 'collect-bugd-evidence.ps1'), 'utf8')
    const assigned = [...ps.matchAll(/^\s{4,}(\w+)\s*=\s*(.+)$/gm)].map((x) => `${x[1]} = ${x[2].trim()}`)

    const ALLOWED = [
      // per segment: shape only. `words` is a COUNT, never the words.
      'speaker = $s.speaker',
      'channel = $s.channel',
      'epoch = $s.epoch',
      'role = $s.role',
      'kind = $s.kind',
      'confidence = $s.confidence',
      'unlabelled = $s.unlabelled',
      'words = $wordCount',
      // the ONLY read of $s.text in the output, and it yields a number
      String.raw`gapSeconds = $(if ($s.kind -eq 'gap' -and [string]$s.text -match '\[gap:\s*([\d.]+)\s*s\]') { [double]$Matches[1] } else { $null })`,
      // per call: identifiers, timing, and two presence booleans
      'id = $c.id',
      'createdAt = $c.createdAt',
      'endedAt = $c.endedAt',
      'durationMs = $c.durationMs',
      'speakerCount = $c.speakerCount',
      'hasSummary = [bool]$c.summary',
      'hasCoaching = [bool]$c.coaching',
      'recordOtherParty = $(if ($c.consent) { $c.consent.recordOtherParty } else { $null })',
      'segmentCount = $segs.Count',
      'segments = $segs'
    ]

    const unexpected = assigned.filter((a) => !ALLOWED.includes(a))
    expect(
      unexpected,
      'the collector writes a field that is not on the allowlist. If it is genuinely safe, add it ' +
        'to ALLOWED with a reason; do not delete this assertion.'
    ).toEqual([])

    // and the allowlist is not stale: every entry must still be present, so a
    // field silently REMOVED (e.g. the word count) is caught too.
    const missing = ALLOWED.filter((a) => !assigned.includes(a))
    expect(missing, 'the allowlist names fields the collector no longer writes').toEqual([])
    expect(assigned.length, 'the collector writes nothing at all — this test would pass vacuously').toBe(ALLOWED.length)
  })
})
