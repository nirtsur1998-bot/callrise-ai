// Entry point bundled by conflict-guard-in-app.cjs.
//
// The app's own built main bundle (`out/main/index.js`) cannot be required for
// this: requiring it STARTS the application, against the real profile. So the
// three modules under test are bundled on their own, by the same bundler the
// app's build uses (esbuild, via electron-vite), from the same sources.
export { reconcileStore } from '../../src/main/backup-core'
export { importCall, callBackupPayload } from '../../src/main/calls-fs'
