// M40 — vitest `setupFiles` entry: fail ONCE, with the cause and the fix, when
// Node's own Web Storage global shadows the DOM environment's localStorage.
// The logic and the full story live in ./node-webstorage-guard.ts; this file
// is only the side effect, kept apart so the pin test can drive the check with
// fabricated inputs (the same split strip-provider-env.setup.ts uses).
import { describeWebStorageShadow } from './node-webstorage-guard'

const g = globalThis as unknown as Record<string, unknown>
const message = describeWebStorageShadow({
  nodeVersion: process.versions.node,
  documentType: typeof g['document'],
  localStorageType: typeof g['localStorage'],
  sessionStorageType: typeof g['sessionStorage']
})

if (message) {
  throw new Error(`[node-webstorage-guard] ${message}`)
}
