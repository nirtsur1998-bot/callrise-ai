// The five release-feed checks, from docs/release-feed-verification.md.
// usage: node five-checks.mjs v1.5.2 100
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, statSync, unlinkSync, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const TAG = process.argv[2] || 'v1.5.2'
const EXPECT_PERCENT = Number(process.argv[3] ?? 100)
const REPO = 'nirtsur1998-bot/callrise-ai'
let INSTALLER = 'CallRise-AI-Windows.exe' // replaced from the manifest in check 4
const TMP = 'C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-CALLRISE-AI/b67a90c5-bdae-4aa9-8edd-0a0897da3f23/scratchpad/_feedcheck-installer.exe'

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
  // `rev-list -n 1` rather than `rev-parse TAG^{commit}`: the caret is an escape
  // character in the Windows shell this runs through, so `^{commit}` arrived as
  // `{commit}` and git refused. Same answer, no caret.
  const tagSha = sh(`git rev-list -n 1 ${TAG}`)
  const originMain = sh('git rev-parse origin/main')
  const head = sh('git rev-parse HEAD')
  record(2, 'the tag names the commit that actually shipped',
    tagSha === originMain && tagSha === head,
    `tag        ${tagSha}\norigin/main ${originMain}\nHEAD        ${head}`)
}

// Fetch the manifest FIRST and take the installer filename from its own `path:`.
// The first run hardcoded 'CallRise AI Windows.exe' — GitHub hyphenates asset
// names, so that 404'd, and checks 4 and 5 then hashed a 404 PAGE: "downloaded
// 0.0 MB" and a mismatching sha512 that looked exactly like a real feed problem.
// The manifest's path is what electron-updater actually follows, so verifying
// THAT is both more robust and more correct than any guess.
let manifest = await (await fetch(`https://github.com/${REPO}/releases/latest/download/latest.yml`)).text()
const fromManifest = manifest.match(/^path:\s*(.+)$/m)?.[1]?.trim()
if (fromManifest) {
  console.log(`[setup] installer name taken from latest.yml's own path: ${fromManifest}`)
  INSTALLER = fromManifest
} else {
  console.log('[setup] *** latest.yml has no path: field — falling back to a guess ***')
}

// ── 3 ─────────────────────────────────────────────────────────────────────
let assets = []
{
  assets = JSON.parse(sh(`gh release view ${TAG} --repo ${REPO} --json assets`)).assets.map((a) => a.name)
  const want = [INSTALLER, 'CallRise-AI-Windows-Portable.exe', `${INSTALLER}.blockmap`, 'latest.yml']
  const missing = want.filter((w) => !assets.includes(w))
  record(3, 'all four assets attached', missing.length === 0,
    `attached: ${assets.join(', ')}` + (missing.length ? `\nMISSING: ${missing.join(', ')}` : ''))
}

// ── 4 ─── the expensive one, and the only one you cannot answer from a page
let _unusedManifestDecl
{
  const base = `https://github.com/${REPO}/releases/latest/download`
  const version = manifest.match(/^version:\s*(.+)$/m)?.[1]?.trim()
  const sha512 = manifest.match(/^sha512:\s*(.+)$/m)?.[1]?.trim()
  console.log(`\n[check 4] manifest says version=${version}  sha512=${(sha512 || '').slice(0, 24)}…`)
  console.log('[check 4] downloading the REAL installer to hash it independently…')

  if (existsSync(TMP)) unlinkSync(TMP)
  const res = await fetch(`${base}/${encodeURIComponent(INSTALLER)}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(TMP))
  const bytes = statSync(TMP).size

  const hash = createHash('sha512')
  const { createReadStream } = await import('node:fs')
  await new Promise((resolve, reject) => {
    createReadStream(TMP).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject)
  })
  const actual = hash.digest('base64')

  record(4, 'latest.yml from the PUBLIC url matches the ACTUAL installer bytes',
    version === TAG.replace(/^v/, '') && sha512 === actual,
    `version in manifest : ${version}   (tag ${TAG})\n` +
      `sha512 in manifest  : ${sha512}\n` +
      `sha512 of download  : ${actual}\n` +
      `downloaded          : ${(bytes / 1e6).toFixed(1)} MB\n` +
      `NOT the manifest against itself — this hash is of the bytes GitHub served.`)
  unlinkSync(TMP)
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

console.log('\n════════════════════════════════════════')
results.forEach((r) => console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.n}. ${r.name}`))
const failed = results.filter((r) => !r.pass)
console.log(failed.length ? `\n*** ${failed.length} CHECK(S) FAILED ***` : '\nAll five checks pass.')
process.exit(failed.length ? 1 : 0)
