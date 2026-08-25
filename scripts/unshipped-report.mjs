#!/usr/bin/env node
// BUILT-VS-SHIPPED. Two reports, both stated in DAYS.
//
// WHY THIS EXISTS: BUG-095 was fixed, verified, and reported as fixed on
// 2026-08-24. It then sat on an unmerged branch while the founder hit the bug
// daily, believing it handled. "Fixed", "merged" and "shipped" are three
// different claims, and merging is the one most easily spoken as if it were
// the third. Nothing reported the gap; it was found because the founder
// complained.
//
// AGE IS THE POINT, not the inventory. "unshipped" is a status. "unshipped,
// 6 days" is an alarm. The threshold is what makes this act like the second.
//
// ---------------------------------------------------------------------------
// THE LIMITATION, STATED UP FRONT RATHER THAN DISCOVERED LATER:
//
// Run in CI, this can only see refs that were PUSHED. The branch that caused
// BUG-095 was never pushed, so a CI-only version of this report would NOT have
// caught the exact case it was built for. That is not a reason to skip CI --
// report A (merged but unreleased) is real and CI is the right place for it --
// but it is a reason to run this LOCALLY too, where unpushed work is visible.
// Every report says which refs it could actually see, so an empty section
// never reads as "nothing is outstanding" when it means "nothing was visible".
// ---------------------------------------------------------------------------
import { execFileSync } from 'node:child_process'

const DAY_MS = 86_400_000
const MERGED_UNRELEASED_ALARM_DAYS = Number(process.env['UNSHIPPED_ALARM_DAYS'] ?? 3)
const UNMERGED_ALARM_DAYS = Number(process.env['UNMERGED_ALARM_DAYS'] ?? 10)

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()

const daysSince = (iso) => Math.floor((Date.now() - Date.parse(iso)) / DAY_MS)
const plural = (n) => (n === 1 ? '1 day' : `${n} days`)

/** The newest release tag reachable from main, or null if there is none. */
function latestReleaseTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*.*.*', 'origin/main')
  } catch {
    return null
  }
}

function commitsBetween(from, to) {
  const raw = git('log', '--format=%H%x00%cI%x00%s', `${from}..${to}`)
  if (!raw) return []
  return raw.split('\n').map((line) => {
    const [sha, iso, subject] = line.split('\0')
    return { sha: sha.slice(0, 7), iso, subject, age: daysSince(iso) }
  })
}

// --- Report A: merged into main, not in any release -------------------------
// Everything here PASSED CI to get onto main, so "verified" is a fact about
// this section and not an assumption.
function mergedButUnreleased() {
  const tag = latestReleaseTag()
  if (!tag) return { tag: null, commits: [] }
  return { tag, commits: commitsBetween(tag, 'origin/main') }
}

// --- Report B: exists as a branch, not merged into main ---------------------
// Verification status here is UNKNOWN. An unmerged branch may be finished and
// tested, or abandoned halfway. The report says so rather than implying either.
function unmergedBranches() {
  const heads = git('for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(Boolean)
    .filter((b) => b !== 'main')
  const out = []
  for (const branch of heads) {
    let ahead
    try {
      ahead = commitsBetween('origin/main', branch)
    } catch {
      continue
    }
    if (ahead.length === 0) continue // fully merged; nothing outstanding
    const oldest = ahead[ahead.length - 1]
    out.push({
      branch,
      commits: ahead.length,
      oldestAge: oldest.age,
      newestAge: ahead[0].age,
      newestSubject: ahead[0].subject
    })
  }
  return out.sort((a, b) => b.oldestAge - a.oldestAge)
}

// --- render -----------------------------------------------------------------
const scope = process.env['CI'] ? 'CI (PUSHED refs only)' : 'local checkout (includes unpushed work)'
const lines = []
let alarm = false

lines.push('# Built vs shipped')
lines.push('')
lines.push(`Refs visible to this run: **${scope}**.`)
if (process.env['CI']) {
  lines.push('')
  lines.push(
    '> A branch that was never pushed is invisible here. BUG-095 — the case this report ' +
      'exists for — was exactly that. Run this locally as well; an empty section below means ' +
      '"nothing visible", not "nothing outstanding".'
  )
}

const a = mergedButUnreleased()
lines.push('')
lines.push(`## A. Merged into main, not released — verified by CI, in users' hands: no`)
lines.push('')
if (!a.tag) {
  lines.push('_No release tag found; cannot compute._')
} else if (a.commits.length === 0) {
  lines.push(`Nothing. \`main\` is level with **${a.tag}**.`)
} else {
  const oldest = a.commits[a.commits.length - 1]
  const verdict = oldest.age >= MERGED_UNRELEASED_ALARM_DAYS ? '🔴' : '🟢'
  if (oldest.age >= MERGED_UNRELEASED_ALARM_DAYS) alarm = true
  lines.push(
    `${verdict} **${a.commits.length} commit(s) past ${a.tag}. Oldest has been waiting ` +
      `${plural(oldest.age)}.** (alarm at ${MERGED_UNRELEASED_ALARM_DAYS})`
  )
  lines.push('')
  lines.push('| age | commit | subject |')
  lines.push('|---|---|---|')
  for (const c of a.commits) lines.push(`| **${plural(c.age)}** | \`${c.sha}\` | ${c.subject} |`)
}

const b = unmergedBranches()
lines.push('')
lines.push('## B. On a branch, not on main — verification status UNKNOWN')
lines.push('')
if (b.length === 0) {
  lines.push('Nothing visible.')
} else {
  const worst = b[0]
  const verdict = worst.oldestAge >= UNMERGED_ALARM_DAYS ? '🔴' : '🟡'
  if (worst.oldestAge >= UNMERGED_ALARM_DAYS) alarm = true
  lines.push(
    `${verdict} **${b.length} branch(es) with unmerged work. Oldest commit is ` +
      `${plural(worst.oldestAge)} old.** (alarm at ${UNMERGED_ALARM_DAYS})`
  )
  lines.push('')
  lines.push('| oldest | commits | branch | newest subject |')
  lines.push('|---|---|---|---|')
  for (const r of b) {
    lines.push(
      `| **${plural(r.oldestAge)}** | ${r.commits} | \`${r.branch}\` | ${r.newestSubject} |`
    )
  }
  lines.push('')
  lines.push(
    '_This section cannot tell finished-and-tested from abandoned-halfway. Age is the signal; ' +
      'the judgement is yours._'
  )
}

const report = lines.join('\n')
console.log(report)

if (process.env['GITHUB_STEP_SUMMARY']) {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(process.env['GITHUB_STEP_SUMMARY'], report + '\n')
}

if (alarm && process.env['UNSHIPPED_FAIL_ON_ALARM'] !== '0') {
  console.error(
    '\n::error::Verified work has been sitting unshipped past the threshold. ' +
      'This job fails on purpose — a report nobody is required to read is the same class ' +
      'of thing as a comment nobody is required to honour.'
  )
  process.exit(1)
}
