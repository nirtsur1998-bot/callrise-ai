// CHECK 6 — read the version out of the BUILT ARTIFACT, not out of the plan.
//
// WHY THIS EXISTS, and it is the whole justification for walking a packaged
// build at all. On 2026-09-08 the M37 installer was built from merged main,
// installed cleanly over 1.10.0 on a clean VM (silent, exit 0, exe rewritten),
// launched, and rendered correctly — and reported its version as 1.10.0.0,
// because package.json had never been bumped. Every document in the release
// said 1.11.0. Nothing in the test suite reads package.json's version, and the
// release documents are prose.
//
// Tagging that build 1.11.0 would have shipped a release that installs
// correctly, runs correctly, and REACHES NOBODY: electron-updater compares
// versions, so every existing 1.10.0 install would have seen no upgrade. The
// perfect silent failure — every check green, every document saying 1.11.0,
// and the one number that decides whether anyone receives it saying 1.10.0.
//
// Species 40's shape: a check that passes ("installer exit 0") answering a
// narrower question than the one that matters.
//
// usage:
//   node artifact-version.mjs 1.11.0
//   node artifact-version.mjs 1.11.0 --exe "C:/path/to/CallRiseAI.exe"
//
// With no --exe it reads the unpacked build's exe under dist/, which is the
// same binary the installer carries.
//
// ── ONE CAVEAT, SO NOBODY QUOTES A PASS AS MORE THAN IT IS ───────────────────
//
// The FRESHNESS half below compares the artifact's FILE MTIME against a commit
// time. That is meaningful for a LOCAL build, where mtime is when the build
// wrote the file. It is MEANINGLESS for a DOWNLOADED artifact, where mtime is
// when curl finished — always "now", so it always passes, and it passes just as
// happily over a binary built from the wrong commit.
//
// So: pointing --exe at something you just downloaded from the release exercises
// the VERSION half only. The freshness line in that run is noise. Do not cite it
// as evidence that a shipped artifact is current; it cannot answer that. What
// can: the release workflow's own headSha, which says which commit CI built.
// (Recorded 2026-09-09, when this exact pass appeared under v1.11.0's checks and
// was reported as a caveat rather than counted.)
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const expected = (process.argv[2] || '').replace(/^v/, '')
if (!expected) {
  console.error(
    'usage: node artifact-version.mjs <expected-version> [--exe <path.exe> | --app <path.app>]'
  )
  process.exit(2)
}
const exeArgIndex = process.argv.indexOf('--exe')
const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass })
  console.log(`\n${pass ? 'PASS' : '*** FAIL ***'}  ${name}`)
  String(detail)
    .split('\n')
    .forEach((l) => console.log('    ' + l))
}

// ── package.json, the source the build stamps FROM ───────────────────────────
const pkgVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
record(
  'package.json declares the version being released',
  pkgVersion === expected,
  `package.json  ${pkgVersion}\nexpected      ${expected}`
)

// ── the built artifact, the thing users actually receive ─────────────────────
//
// MACOS, added 2026-09-17 (M40). This check was Windows-only by construction:
// it shelled out to PowerShell for the exe's VersionInfo.ProductVersion, so on
// a Mac release there was no sixth check at all. The macOS equivalent of "read
// the version out of the thing that ships, not out of the plan" is the app
// bundle's own Info.plist:
//
//   /usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
//     "dist/mac-arm64/CallRise AI.app/Contents/Info.plist"
//
// `--exe` keeps working untouched so the existing Windows job needs no edit;
// `--app` is its macOS counterpart. With neither, both default candidate sets
// are probed and whichever exists is checked — so this runs correctly on either
// platform without being told which one it is on.
const appArgIndex = process.argv.indexOf('--app')
const artifactArgIndex = exeArgIndex > -1 ? exeArgIndex : appArgIndex

const candidates =
  artifactArgIndex > -1
    ? [process.argv[artifactArgIndex + 1]]
    : [
        join('dist', 'win-unpacked', 'CallRiseAI.exe'),
        join('dist', 'win-arm64-unpacked', 'CallRiseAI.exe'),
        join('dist', 'mac-arm64', 'CallRise AI.app'),
        join('dist', 'mac', 'CallRise AI.app'),
        join('dist', 'mac-universal', 'CallRise AI.app')
      ]

/**
 * Read the version an artifact reports about ITSELF.
 *
 * Dispatches on the artifact's shape rather than on process.platform, because
 * the question is "what kind of thing is this", and a path is the only evidence
 * available when someone passes --exe/--app explicitly.
 *
 * Returns { version } or { error }.
 */
function readArtifactVersion(artifactPath) {
  if (artifactPath.endsWith('.app')) {
    const plist = join(artifactPath, 'Contents', 'Info.plist')
    if (!existsSync(plist)) return { error: `no Info.plist at ${plist}` }
    try {
      const out = execFileSync(
        '/usr/libexec/PlistBuddy',
        ['-c', 'Print :CFBundleShortVersionString', plist],
        { encoding: 'utf8' }
      ).trim()
      return { version: out }
    } catch (err) {
      return { error: err.message }
    }
  }
  // Windows: PowerShell rather than parsing PE ourselves — this is the same
  // field Windows shows in Properties, and the one electron-updater compares.
  const ps = `(Get-Item '${artifactPath.replace(/'/g, "''")}').VersionInfo.ProductVersion`
  try {
    return { version: execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).trim() }
  } catch (err) {
    return { error: err.message }
  }
}

const found = candidates.filter((p) => p && existsSync(p))
if (found.length === 0) {
  record(
    'the built artifact reports the version being released',
    false,
    `no artifact found. looked in:\n  ${candidates.join('\n  ')}\nBuild first, or pass --exe / --app.`
  )
} else {
  for (const artifact of found) {
    const { version: actual, error } = readArtifactVersion(artifact)
    if (error) {
      record(`artifact version: ${artifact}`, false, `could not read: ${error}`)
      continue
    }
    // electron-builder stamps Windows ProductVersion as x.y.z.0 or x.y.z;
    // CFBundleShortVersionString is plain x.y.z.
    const normalised = actual.replace(/\.0$/, '')
    record(
      `the built artifact reports the version being released (${artifact})`,
      normalised === expected || actual === expected,
      `artifact  ${actual}\nexpected  ${expected}`
    )
  }
}

// ── and it must POST-DATE the code it is supposed to contain ─────────────────
//
// THE SECOND HALF, added 2026-09-09 because the first half alone reported a
// clean pass over a stale artifact. The BUG-237 rebuild exited 1 partway
// through (electron-builder's arm64 file walk hit a transient ENOENT on an
// MSBuild .tlog), and the wrapper that reported "BUILD DONE, version 1.11.0"
// had read that version out of a latest.yml the failed build never rewrote.
// This check then passed — correctly, on its own terms: the artifact on disk
// really did say 1.11.0. It was simply an hour older than the fix it was
// supposed to contain, and nothing anywhere would have said so.
//
// Version-correct is not the same as current, and this is the quiet failure:
// a green check standing over a binary that predates the code.
//
// THE REFERENCE IS THE LAST COMMIT THAT TOUCHED SHIPPED SOURCE, not HEAD.
// Against HEAD this would fail on every test-only or docs-only commit and
// demand a fifteen-minute rebuild that could not change a byte of the output —
// and a check that cries wolf on correct states is one people learn to wave
// through, which is how the version check came to be needed in the first
// place. So it asks the question it actually means: could this binary contain
// the code being released?
// AND "shipped" EXCLUDES TESTS. The first real run of this check failed on a
// test-only commit, because `src` contains `src/**/__tests__/**` — which the
// bundler never compiles and electron-builder's `files` list drops wholesale
// (the app ships `out/`, and `!src/*` is the first line of that list). It cried
// wolf on a correct state on its first outing, which is the precise thing the
// paragraph above says makes a check worthless. Fixed rather than waved
// through: pathspec exclusions, passed as argv so no shell mangles `:(exclude)`.
const SHIPPED = [
  'src',
  ':(exclude)src/**/__tests__/**',
  ':(exclude)src/**/*.test.ts',
  ':(exclude)src/**/*.test.tsx',
  'package.json',
  'package-lock.json',
  'electron-builder.yml',
  'build',
  'native',
  'resources'
]
try {
  const gitLog = (fmt) =>
    execFileSync('git', ['log', '-1', `--format=${fmt}`, '--', ...SHIPPED], { encoding: 'utf8' }).trim()
  const stamp = gitLog('%ct')
  const srcTime = Number(stamp) * 1000
  if (!stamp || Number.isNaN(srcTime)) throw new Error('no commit found touching shipped source')
  const srcCommit = gitLog('%h %s')
  for (const artifact of found) {
    // For a .app this is the bundle directory's own mtime, which electron-builder
    // writes when it finishes assembling it — the same "when was this produced
    // here" question the exe's mtime answers, with the same download caveat below.
    const built = statSync(artifact).mtimeMs
    const skewMin = Math.round((built - srcTime) / 60000)
    // mtime means "when this file was written here". For a local build that is
    // the build. For a DOWNLOAD it is when the transfer finished — always now,
    // so it always passes, including over a binary built from the wrong commit.
    // Say so in the output rather than only in a comment nobody opens.
    const downloadedRecently = artifactArgIndex > -1 && Date.now() - built < 60 * 60 * 1000
    record(
      `the artifact post-dates the last change to shipped source (${artifact})`,
      built >= srcTime,
      `last shipped-source commit  ${new Date(srcTime).toISOString()}  ${srcCommit}\n` +
        `artifact built              ${new Date(built).toISOString()}\n` +
        (built >= srcTime
          ? `artifact is ${skewMin} min newer — it can contain that commit`
          : `artifact is ${-skewMin} min OLDER — it CANNOT contain that commit. Rebuild.`) +
        (downloadedRecently
          ? '\nNOT EVIDENCE: this file was written under an hour ago via --exe. If you downloaded it,\n' +
            'that mtime is the download time, not the build time, and this line would pass over any\n' +
            'binary at all. Only the VERSION check above means anything here. For a shipped artifact,\n' +
            "ask the release run's headSha which commit CI actually built."
          : '')
    )
  }
} catch (err) {
  record(
    'the artifact post-dates the last change to shipped source',
    false,
    `could not read git history: ${err.message}`
  )
}

const failed = results.filter((r) => !r.pass)
console.log(
  `\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length} check(s)`
)
if (failed.length) {
  console.log(
    '\nDo not tag. An artifact announcing the wrong version reaches nobody; one that predates' +
      '\nthe code reaches everybody, carrying the bug the release was cut to fix.'
  )
  process.exit(1)
}
