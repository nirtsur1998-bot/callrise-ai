// BUG-117 — make "a missing denoiser fails the build" actually true.
//
// electron-builder.yml said it twice, in two different blocks:
//
//   win:  "If the staging directory is missing at build time this FAILS the
//          build rather than quietly producing an installer without a
//          denoiser — same posture as the mac block"
//   mac:  "If that sibling repo isn't present at build time, this step fails
//          loudly (a missing denoiser shouldn't ship silently)."
//
// Neither was true. electron-builder's `extraResources` does not fail on a
// missing source — app-builder-lib/out/fileMatcher.js's copyFiles() does:
//
//     const fromStat = await statOrNull(matcher.from)
//     if (fromStat == null) {
//       log.warn({ from: matcher.from }, `file source doesn't exist`)
//       return
//     }
//
// Warn, then return. Verified empirically, not inferred: renaming
// build/virtualmic-win/ aside and rebuilding produced two warning lines,
// EXIT CODE 0, and a complete dist/win-unpacked with no virtualmic-win/ in
// resources at all — a fully installable app with no denoiser.
//
// WHY THIS MATTERS MORE THAN AN ORDINARY MISSING FILE. Shipping without the
// denoiser is not hypothetical: it already happened to every Windows user
// once (see the long comment above the win extraResources block). These two
// comments are the stated defence against a repeat, and the defence did not
// exist. On Windows the exposure is currently latent — the binaries are
// committed to this repo. On macOS it is LIVE: the source is a sibling
// checkout `../salesos-virtualmic`, there is no macOS CI anywhere in this
// repo, and any Mac without that checkout builds a silent no-denoiser .dmg
// today.
//
// The warnings are not a safety net either. release.yml runs
// `npx electron-builder ... > electron-builder.log 2>&1`, so on a successful
// build nothing ever reads them.
//
// This runs as `beforePack`, before any packaging work happens, so a failure
// costs seconds rather than a full package. Throwing from a beforePack hook
// aborts the build with a non-zero exit — which is what both comments always
// claimed.
const { existsSync } = require('node:fs')
const { join, resolve } = require('node:path')

/**
 * What each platform must have on disk before packaging is allowed to start.
 * Paths mirror electron-builder.yml's own `extraResources` entries exactly —
 * if you add an entry there, add it here, or the guarantee quietly narrows.
 */
const REQUIRED_INPUTS = {
  win32: {
    label: 'Windows Tier 1 noise-cancellation engine',
    // Relative to the repo root. Sourced from inside the repo on purpose —
    // see the extraResources comment for why a sibling path was rejected.
    paths: ['build/virtualmic-win/kern_bridge.exe', 'build/virtualmic-win/DeepFilterNet3_onnx.tar.gz'],
    remedy:
      'These are committed to this repo. If they are missing, your checkout is\n' +
      '  incomplete — try `git checkout -- build/virtualmic-win/`.'
  },
  darwin: {
    label: 'macOS noise-cancellation engine (michelper + HAL driver + model)',
    // A SIBLING CHECKOUT, which is exactly why this guard matters more here:
    // nothing in this repo can make these appear, and no macOS CI exists.
    paths: [
      '../salesos-virtualmic/build/michelper',
      '../salesos-virtualmic/build/SalesOSMicrophone.driver',
      '../salesos-virtualmic/phase2/models/DeepFilterNet3_onnx.tar.gz'
    ],
    remedy:
      'These come from the separate salesos-virtualmic repo, checked out as a\n' +
      '  SIBLING of this one and already built. Clone/build it next to this repo,\n' +
      '  or build with the mac target disabled if you deliberately want no denoiser.'
  }
}

exports.default = async function verifyBuildInputs(context) {
  const platform = context.electronPlatformName
  const required = REQUIRED_INPUTS[platform]

  // Linux has no denoiser by design, so there is nothing to require. Stated
  // rather than silently falling through, so the next platform added has to
  // make a deliberate choice here instead of inheriting "no checks".
  if (!required) {
    console.log(`[verify-build-inputs] ${platform}: no required build inputs declared — skipping`)
    return
  }

  const repoRoot = resolve(__dirname, '..')
  const missing = required.paths.filter((p) => !existsSync(join(repoRoot, p)))

  if (missing.length > 0) {
    const lines = [
      '',
      `  Refusing to package: the ${required.label} is missing.`,
      '',
      ...missing.map((p) => `    MISSING  ${p}`),
      '',
      '  Packaging would have SUCCEEDED without these and produced an installer',
      '  with no denoiser in it — electron-builder only warns about a missing',
      '  extraResources source. That exact failure has shipped to every Windows',
      '  user once already, which is why this check exists.',
      '',
      `  ${required.remedy}`,
      ''
    ]
    throw new Error(lines.join('\n'))
  }

  console.log(
    `[verify-build-inputs] ${platform}: all ${required.paths.length} required build inputs present`
  )
}
