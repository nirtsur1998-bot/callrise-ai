// The release-feed checks, from docs/release-feed-verification.md.
// usage: node five-checks.mjs v1.5.2 100 [--mac]
//
// MACOS, added 2026-09-17 (M40). Checks 1-5 read the feed electron-updater
// actually follows. On macOS that feed is a DIFFERENT file — `latest-mac.yml`,
// not `latest.yml` — so without `--mac` a Mac release would be checked against
// Windows' manifest, which either 404s or, worse, passes against the wrong
// platform's artifact.
//
// `--mac` changes three things and nothing else: which manifest is fetched,
// which assets check 3 expects, and (because the Mac feed's `path:` is the ZIP,
// not the DMG — see electron-builder.yml's mac.target comment) what check 4
// downloads and hashes. Default is unchanged, so the existing Windows
// invocation needs no edit.
//
// CHECK 6 (Windows only), added 2026-09-19. Read the version back out of the
// DOWNLOADED ARTIFACT ITSELF — the installer's own VERSIONINFO resource — not
// out of any manifest, page, or filename. This is the check that caught a
// release once stamped 1.10.0 that installed fine, ran fine, and would have
// updated nobody, because nothing had asked the .exe what it actually thought
// its own version was.
//
// It existed for three earlier releases (v1.12.0-v1.14.0) as a SEPARATE script
// in one session's scratchpad — never checked in, never run by anyone else,
// never wired into `run.mjs` or any workflow. That is the finding this comment
// exists to name: a verification step nobody but its author can run is a
// HABIT, not a GATE — it protects a release only for as long as that one
// person remembers, from that one machine. Folded into the checked-in script
// now specifically because it almost happened again: the Mac side built and
// wired its own PlistBuddy equivalent (reading CFBundleShortVersionString) for
// M40, so the Mac artifact was getting a version check and the Windows one was
// not, in the same joint release. Windows-only here — bundle/Info.plist has no
// VERSIONINFO resource, and duplicating the Mac's own check is not this file's
// job. `--mac` skips it and says why, rather than silently reporting five of
// six and letting a reader miss that the sixth never ran.
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, statSync, unlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const TAG = process.argv[2] || 'v1.5.2'
const EXPECT_PERCENT = Number(process.argv[3] ?? 100)
const MAC = process.argv.includes('--mac')
const REPO = 'nirtsur1998-bot/callrise-ai'
const MANIFEST = MAC ? 'latest-mac.yml' : 'latest.yml'
// A guess, replaced from the manifest's own `path:` below — which is the point
// of fetching the manifest first (see the note above check 2).
let INSTALLER = MAC ? 'CallRise-AI-mac.zip' : 'CallRise-AI-Windows.exe'
// Was a hardcoded absolute path under C:/Users/User/... — i.e. this script could
// only ever run on one machine. The OS temp dir works on both.
const TMP = join(tmpdir(), `callrise-feedcheck-artifact${MAC ? '.zip' : '.exe'}`)

const sh = (c) => execSync(c, { encoding: 'utf8', maxBuffer: 1e8 }).trim()
const results = []
const record = (n, name, pass, detail) => {
  results.push({ n, name, pass, detail })
  console.log(`\n${pass ? 'PASS' : '*** FAIL ***'}  CHECK ${n} — ${name}`)
  detail.split('\n').forEach((l) => console.log('    ' + l))
}

// ── 1 ─────────────────────────────────────────────────────────────────────
{
  const j = JSON.parse(sh(`gh release view ${TAG} --repo ${REPO} --json isDraft,isPrerelease,publishedAt`))
  record(1, 'live, not a draft and not a prerelease',
    j.isDraft === false && j.isPrerelease === false && Boolean(j.publishedAt),
    `isDraft=${j.isDraft}  isPrerelease=${j.isPrerelease}  publishedAt=${j.publishedAt}`)
}

// ── 2 ─────────────────────────────────────────────────────────────────────
{
  sh('git fetch origin --tags')
  sh('git fetch origin main')
  // `rev-list -n 1` rather than `rev-parse TAG^{commit}`: the caret is an escape
  // character in the Windows shell this runs through, so `^{commit}` arrived as
  // `{commit}` and git refused. Same answer, no caret.
  const tagSha = sh(`git rev-list -n 1 ${TAG}`)
  const originMain = sh('git rev-parse origin/main')
  const head = sh('git rev-parse HEAD')
  // NOT tagSha === originMain. That was wrong from the start for any repo
  // where main keeps moving after a tag is cut — which is the normal case,
  // not an edge case: v1.15.0 shipped this exact way, tagged mid-sequence
  // while a second, independent branch-merge sequence kept landing on main
  // in parallel. The exact-equality version failed CHECK 2 on the very
  // first real dual-platform release even though the tag was byte-correct
  // (proven separately by check 4's hash match) — a false alarm from an
  // assumption, not a finding about the release. What actually matters:
  // the tag's commit must be an ANCESTOR of main (it was really merged in,
  // not built from an orphaned/force-pushed ref main never had), and HEAD
  // (what this checkout built from) must be the tag. Ordering, not equality.
  let isAncestor = false
  try {
    sh(`git merge-base --is-ancestor ${tagSha} origin/main`)
    isAncestor = true
  } catch {
    isAncestor = false
  }
  record(2, "the tag's commit is really on main's history, and HEAD matches it",
    isAncestor && tagSha === head,
    `tag        ${tagSha}\norigin/main ${originMain}  (${isAncestor ? 'tag is an ancestor — OK, main may have since moved further' : 'tag is NOT reachable from main — real problem'})\nHEAD        ${head}`)
}

// Fetch the manifest FIRST and take the installer filename from its own `path:`.
// The first run hardcoded 'CallRise AI Windows.exe' — GitHub hyphenates asset
// names, so that 404'd, and checks 4 and 5 then hashed a 404 PAGE: "downloaded
// 0.0 MB" and a mismatching sha512 that looked exactly like a real feed problem.
// The manifest's path is what electron-updater actually follows, so verifying
// THAT is both more robust and more correct than any guess.
let manifest = await (
  await fetch(`https://github.com/${REPO}/releases/latest/download/${MANIFEST}`)
).text()
const fromManifest = manifest.match(/^path:\s*(.+)$/m)?.[1]?.trim()
if (fromManifest) {
  console.log(`[setup] artifact name taken from ${MANIFEST}'s own path: ${fromManifest}`)
  INSTALLER = fromManifest
} else {
  console.log(`[setup] *** ${MANIFEST} has no path: field — falling back to a guess ***`)
}

// ── 3 ─────────────────────────────────────────────────────────────────────
let assets = []
{
  assets = JSON.parse(sh(`gh release view ${TAG} --repo ${REPO} --json assets`)).assets.map((a) => a.name)
  // On macOS the expected set is DERIVED from the manifest's own `files:` rather
  // than hardcoded, for the same reason check 2 takes the installer name from
  // `path:`: a hardcoded guess is how check 4 once hashed a 404 page. Windows
  // keeps its explicit list, which also pins the portable exe — an artifact the
  // manifest deliberately does not mention.
  const want = MAC
    ? [...new Set([...manifest.matchAll(/^\s*-?\s*url:\s*(.+)$/gm)].map((m) => m[1].trim())), MANIFEST]
    : [INSTALLER, 'CallRise-AI-Windows-Portable.exe', `${INSTALLER}.blockmap`, MANIFEST]
  const missing = want.filter((w) => !assets.includes(w))
  // Counted, not spelled "four": the Mac set is three, and a check whose own
  // name disagrees with what it checked is the first thing a reader stops
  // trusting.
  record(3, `all ${want.length} expected assets attached`, missing.length === 0,
    `attached: ${assets.join(', ')}` + (missing.length ? `\nMISSING: ${missing.join(', ')}` : ''))
}

// ── 4 ─── the expensive one, and the only one you cannot answer from a page
let bytes = 0
{
  const base = `https://github.com/${REPO}/releases/latest/download`
  const version = manifest.match(/^version:\s*(.+)$/m)?.[1]?.trim()
  const sha512 = manifest.match(/^sha512:\s*(.+)$/m)?.[1]?.trim()
  console.log(`\n[check 4] manifest says version=${version}  sha512=${(sha512 || '').slice(0, 24)}…`)
  console.log('[check 4] downloading the REAL installer to hash it independently…')

  if (existsSync(TMP)) unlinkSync(TMP)
  const res = await fetch(`${base}/${encodeURIComponent(INSTALLER)}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(TMP))
  bytes = statSync(TMP).size

  const hash = createHash('sha512')
  const { createReadStream } = await import('node:fs')
  await new Promise((resolve, reject) => {
    createReadStream(TMP).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject)
  })
  const actual = hash.digest('base64')

  record(4, `${MANIFEST} from the PUBLIC url matches the ACTUAL artifact bytes`,
    version === TAG.replace(/^v/, '') && sha512 === actual,
    `version in manifest : ${version}   (tag ${TAG})\n` +
      `sha512 in manifest  : ${sha512}\n` +
      `sha512 of download  : ${actual}\n` +
      `downloaded          : ${(bytes / 1e6).toFixed(1)} MB\n` +
      `NOT the manifest against itself — this hash is of the bytes GitHub served.`)
  // NOT deleted here on Windows — check 6 below reads THIS SAME downloaded
  // file's VERSIONINFO resource. Re-downloading it a second time for that
  // would work too, but would mean a network hiccup between the two checks
  // could make them hash and version-check two DIFFERENT bytes without
  // either check's own pass/fail saying so. Mac has no check 6, so its
  // artifact is deleted immediately, matching the behaviour before this
  // comment existed.
  if (MAC) unlinkSync(TMP)
}

// ── 5 ─────────────────────────────────────────────────────────────────────
{
  const latest = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: 'follow' })
  const resolvedTag = latest.url.split('/').pop()
  const head = await fetch(
    `https://github.com/${REPO}/releases/latest/download/${encodeURIComponent(INSTALLER)}`,
    { method: 'HEAD', redirect: 'follow' }
  )
  const staging = manifest.match(/^stagingPercentage:\s*(.+)$/m)?.[1]?.trim()
  const stagingOk = EXPECT_PERCENT >= 100 ? staging === undefined : Number(staging) === EXPECT_PERCENT
  record(5, '/releases/latest resolves, installer serves, rollout is right',
    resolvedTag === TAG && head.status === 200 && stagingOk,
    `/releases/latest -> ${resolvedTag}  (expect ${TAG})\n` +
      `installer HEAD    -> ${head.status}\n` +
      `stagingPercentage -> ${staging ?? '(absent)'}  ` +
      (EXPECT_PERCENT >= 100
        ? '— correctly ABSENT for a 100% release'
        : `— expected ${EXPECT_PERCENT}`))
}

// ── 6 (Windows only) ─── the version READ OUT OF THE ARTIFACT ITSELF, and
// that the artifact is the NSIS installer (its blockmap covers exactly its
// bytes) rather than, say, the portable exe served under the wrong name.
if (MAC) {
  console.log(
    '\n[check 6] skipped on --mac — the Mac side reads CFBundleShortVersionString ' +
      'via its own PlistBuddy step, wired into its own workflow. Not duplicated here.'
  )
} else {
  const info = sh(
    `pwsh -NoProfile -Command "$v=(Get-Item '${TMP}').VersionInfo; ` +
      `Write-Output ($v.ProductVersion + '|' + $v.FileVersion + '|' + $v.ProductName + '|' + $v.CompanyName)"`
  )
  const [productVersion, fileVersion, productName, company] = info.split('|')
  const want = TAG.replace(/^v/, '')
  let blockmapTotal = null
  try {
    const bm = await (
      await fetch(`https://github.com/${REPO}/releases/download/${TAG}/${encodeURIComponent(INSTALLER)}.blockmap`)
    ).arrayBuffer()
    const { gunzipSync } = await import('node:zlib')
    // electron-builder's blockmap: gzipped JSON, files[].sizes is an ARRAY of
    // block lengths (there is no per-file `size`); the total is every block.
    const parsed = JSON.parse(gunzipSync(Buffer.from(bm)).toString('utf8'))
    blockmapTotal = (parsed.files ?? []).reduce(
      (s, f) => s + (f.sizes ?? []).reduce((a, b) => a + b, 0),
      0
    )
  } catch (e) {
    blockmapTotal = `unreadable: ${e.message}`
  }
  // startsWith, not exact equality, for BOTH fields — verified against the
  // real installed v1.14.0 exe on this machine before trusting it: its
  // ProductVersion reads back as "1.14.0.0" (Windows VERSIONINFO's own
  // four-part convention), not the plain three-part semver, so an exact-match
  // check here would have FAILED a genuinely correct release. Caught by
  // testing the mechanism against a real artifact, not by reasoning about it.
  record(
    6,
    'the downloaded artifact itself says it is this version',
    (productVersion || '').trim().startsWith(want) &&
      (fileVersion || '').startsWith(want) &&
      blockmapTotal === bytes,
    `ProductVersion (from the exe's VERSIONINFO) : ${productVersion}   (expect ${want})\n` +
      `FileVersion                                : ${fileVersion}\n` +
      `ProductName / Company                      : ${productName} / ${company}\n` +
      `blockmap covers                            : ${blockmapTotal} bytes vs downloaded ${bytes} ` +
      `— the file is the NSIS installer, not the portable`
  )
  unlinkSync(TMP)
}

console.log('\n════════════════════════════════════════')
results.forEach((r) => console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.n}. ${r.name}`))
const failed = results.filter((r) => !r.pass)
console.log(
  failed.length
    ? `\n*** ${failed.length} CHECK(S) FAILED ***`
    : `\nAll ${results.length} checks pass.`
)
process.exit(failed.length ? 1 : 0)
