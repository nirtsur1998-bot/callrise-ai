// Cross-platform native-addon build helper (used by npm run native:build:mac
// and :win). Plain Node, not shell syntax - `$(...)` subshell substitution
// (what a naive package.json script would use to inject the Electron
// version) only works under bash, not Windows' cmd.exe/PowerShell, which is
// what `npm run` actually invokes scripts through on Windows by default.
//
// IMPORTANT: this targets Electron's bundled Node ABI (via --dist-url +
// --target), NOT the system Node used to run this very script. Electron
// ships its own Node.js with its own NODE_MODULE_VERSION - a native addon
// built against system Node's ABI throws "was compiled against a different
// Node.js version" the moment the real app's main process tries to
// require() it. Confirmed on this machine: system Node was ABI 147,
// Electron 39.8.10 is ABI 140 - a plain `node-gyp rebuild` addon silently
// never loaded in the real app (caught by the adapter's own try/catch,
// isSupported() just returns false) even though it worked fine under plain
// `tsx` the whole time. See docs/detection.md.
/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS script, not part of the TS app bundle */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

const dir = process.argv[2]
if (!dir) {
  console.error('Usage: node scripts/build-native.js <native-addon-directory>')
  process.exit(1)
}

const electronVersion = require('electron/package.json').version
const nodeGyp = path.join(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp'
)

execFileSync(
  nodeGyp,
  [
    'rebuild',
    '--directory',
    dir,
    '--dist-url=https://electronjs.org/headers',
    `--target=${electronVersion}`
  ],
  // Windows .cmd files aren't directly executable - they must go through a
  // shell (cmd.exe) to run at all. Without this, spawnSync fails immediately
  // with EINVAL before node-gyp ever starts (confirmed in CI on windows-latest).
  { stdio: 'inherit', shell: process.platform === 'win32' }
)
