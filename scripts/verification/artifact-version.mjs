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
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const expected = (process.argv[2] || '').replace(/^v/, '')
if (!expected) {
  console.error('usage: node artifact-version.mjs <expected-version> [--exe <path>]')
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
const candidates =
  exeArgIndex > -1
    ? [process.argv[exeArgIndex + 1]]
    : [
        join('dist', 'win-unpacked', 'CallRiseAI.exe'),
        join('dist', 'win-arm64-unpacked', 'CallRiseAI.exe')
      ]

const found = candidates.filter((p) => p && existsSync(p))
if (found.length === 0) {
  record(
    'the built artifact reports the version being released',
    false,
    `no exe found. looked in:\n  ${candidates.join('\n  ')}\nBuild first, or pass --exe.`
  )
} else {
  for (const exe of found) {
    // PowerShell rather than parsing PE ourselves: this is the same field
    // Windows shows in Properties, and the same one electron-updater compares.
    const ps = `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`
    let actual = ''
    try {
      actual = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8' }).trim()
    } catch (err) {
      record(`artifact version: ${exe}`, false, `could not read: ${err.message}`)
      continue
    }
    // electron-builder stamps ProductVersion as x.y.z.0 or x.y.z.
    const normalised = actual.replace(/\.0$/, '')
    record(
      `the built artifact reports the version being released (${exe})`,
      normalised === expected || actual === expected,
      `artifact  ${actual}\nexpected  ${expected}`
    )
  }
}

const failed = results.filter((r) => !r.pass)
console.log(
  `\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} — ${results.length} check(s)`
)
if (failed.length) {
  console.log('\nDo not tag. A tag whose artifact announces a different version reaches nobody.')
  process.exit(1)
}
