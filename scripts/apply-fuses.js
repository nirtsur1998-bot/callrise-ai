// Electron fuses — flipped at package time, on every platform (§5.3).
//
// Without these, a signed and notarized CallRise AI binary is a general-purpose
// code execution primitive that inherits the app's own TCC permissions:
//
//   ELECTRON_RUN_AS_NODE=1 /Applications/CallRise\ AI.app/Contents/MacOS/CallRise\ AI -e '<anything>'
//
// runs arbitrary JavaScript as us. For an app whose whole reason to exist is
// holding microphone access — and, with consent, the other party's audio —
// that is not a hardening nicety. macOS granted the microphone to *this
// bundle*, and anything running inside it inherits the grant, so the gap
// between "a bug" and "a wiretap someone else can point at your customers" is
// exactly these two flags.
//
// It also matters that the mic permission is the one thing an attacker cannot
// obtain on their own: prompting for it draws attention. Borrowing ours does
// not.
//
// What each one does:
//
//   RunAsNode                          off — kills the ELECTRON_RUN_AS_NODE
//                                            escape hatch above.
//   EnableNodeCliInspectArguments      off — kills --inspect, which would
//                                            otherwise attach a debugger to
//                                            the main process and achieve the
//                                            same thing more comfortably.
//
// EnableEmbeddedAsarIntegrityValidation/OnlyLoadAppFromAsar were tried here
// too (electron-builder.yml's `disableAsarIntegrity: true` has the fuller
// story) and pulled again: on real Windows hardware the packaged build
// refused to launch with "ASAR Integrity Violation: got a hash mismatch",
// which genuinely went away once these two were dropped and
// disableAsarIntegrity was set. Left off on every platform rather than
// win32-only since there's no per-platform switch for electron-builder's own
// embedding step, and a fuse that says "check integrity" with nothing
// embedded to check against fails the same way. The Windows launch failure
// that persisted after this fix turned out to be unrelated to fuses at all -
// see electron-builder.yml's win.target comment.

/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS script, run by electron-builder's afterPack hook, not part of the TS app bundle */
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

/** electron-builder's afterPack hook. */
exports.default = async function applyFuses(context) {
  const { electronPlatformName, appOutDir, packager } = context
  const productName = packager.appInfo.productFilename

  // macOS and Windows both end up naming the binary after productName here —
  // Windows only because electron-builder.yml sets win.executableName to
  // match it exactly. Linux has no such override, and electron-builder's own
  // default there is a filesystem-sanitized, lowercased name ("CallRise AI"
  // becomes "callrise-ai"), not productName verbatim — so it needs
  // packager.executableName, the same accessor electron-builder's own
  // afterPack ecosystem (e.g. its notarize step) uses for exactly this.
  const binary =
    electronPlatformName === 'darwin'
      ? `${appOutDir}/${productName}.app`
      : electronPlatformName === 'win32'
        ? `${appOutDir}/${productName}.exe`
        : `${appOutDir}/${packager.executableName}`

  await flipFuses(binary, {
    version: FuseVersion.V1,
    // Re-signing is handled by electron-builder's own signing step, which runs
    // after this hook — flipping fuses invalidates any signature already
    // applied, so doing it here rather than later is deliberate.
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',

    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false
  })

  console.log(`[fuses] locked ${electronPlatformName}: ${binary}`)
}
