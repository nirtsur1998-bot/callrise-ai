// Runs the ambient-detection headless debug CLI under ELECTRON'S Node
// runtime (via ELECTRON_RUN_AS_NODE=1), not plain system Node/tsx - the
// native addon is built against Electron's ABI (see build-native.js), so it
// can only be require()'d from a process running that same ABI. Setting the
// env var here (not via a shell `set`/`export`, and not the cross-env
// package) keeps this identical on Windows and macOS.
/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS script, not part of the TS app bundle */
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const electronBin = path.join(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
)
const tsxCli = path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')
const debugCli = path.join(__dirname, '..', 'src', 'main', 'detection', 'debug-cli.ts')

const result = spawnSync(electronBin, [tsxCli, debugCli], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})
process.exit(result.status ?? 1)
