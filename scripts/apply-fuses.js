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
// exactly these four flags.
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
//   EnableEmbeddedAsarIntegrityValidation on — the binary refuses to run an
//                                            app.asar whose hash does not
//                                            match the one baked in at build
//                                            time, so the bundle cannot be
//                                            edited in place.
//   OnlyLoadAppFromAsar                on — closes the way around the above:
//                                            without it Electron will happily
//                                            prefer an unpacked `app/`
//                                            directory beside the archive,
//                                            and integrity validation of an
//                                            archive nobody loads is worth
//                                            nothing.
//
// The last two are a pair. Enabling either alone leaves the door open.

/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS script, run by electron-builder's afterPack hook, not part of the TS app bundle */
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

/** electron-builder's afterPack hook. */
exports.default = async function applyFuses(context) {
  const { electronPlatformName, appOutDir, packager } = context
  const productName = packager.appInfo.productFilename

  const binary =
    electronPlatformName === 'darwin'
      ? `${appOutDir}/${productName}.app`
      : electronPlatformName === 'win32'
        ? `${appOutDir}/${productName}.exe`
        : `${appOutDir}/${productName}`

  await flipFuses(binary, {
    version: FuseVersion.V1,
    // Re-signing is handled by electron-builder's own signing step, which runs
    // after this hook — flipping fuses invalidates any signature already
    // applied, so doing it here rather than later is deliberate.
    resetAdHocDarwinSignature: electronPlatformName === 'darwin',

    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  })

  console.log(`[fuses] locked ${electronPlatformName}: ${binary}`)
}
