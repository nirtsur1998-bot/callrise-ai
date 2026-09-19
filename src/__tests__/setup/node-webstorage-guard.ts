// M40 (2026-09-18) — detect Node's own Web Storage global shadowing the test
// DOM's, and say so in ONE sentence instead of seventy-nine.
//
// WHAT HAPPENED. On a Mac running Node 26, the full suite reported
// 14 files / 79 tests failed, eleven of them with the identical
// "Cannot read properties of undefined (reading 'clear')" at localStorage.clear()
// in render suites that declare `// @vitest-environment happy-dom`. happy-dom
// 20.11.2 was installed and matched the lockfile, and its Window exposes
// localStorage - so every obvious explanation was wrong. It read exactly like
// a platform defect ("the renderer suites are broken on macOS").
//
// THE MECHANISM, proven both directions on one file on one machine:
//   Node 26  -> 4 failed        Node 22 (via npx node@22) -> 4 passed
// Node ships its own experimental Web Storage (`localStorage` on globalThis,
// default-on since Node 25). Without `--localstorage-file` that global reads as
// undefined, and vitest's DOM environment does not replace it - so a bare
// `localStorage` in a test resolves to Node's stub, not happy-dom's. CI pins
// Node 22 (.github/workflows), where the global did not yet exist, so the same
// suite is green there. `sessionStorage` is unaffected, which is the tell.
//
// Nothing pinned the Node version, so a machine could drift onto 26 and get
// this with no message naming the cause. Now .nvmrc and package.json#engines
// say 22, and this check turns the seventy-nine failures into one that names
// the fix.
//
// Pure: takes what it inspects as arguments so the pin test can drive it with
// fabricated inputs and prove it fires AND stays quiet, without a real Node 26.

export interface WebStorageShadowInput {
  /** process.versions.node */
  nodeVersion: string
  /** typeof document in this environment - 'object' in a DOM environment */
  documentType: string
  /** typeof localStorage in this environment */
  localStorageType: string
  /** typeof sessionStorage in this environment */
  sessionStorageType: string
}

/**
 * Returns a message describing the shadow when this is a DOM environment whose
 * `localStorage` is missing, or null when there is nothing to report.
 *
 * Deliberately narrow: a plain `node` environment has no document and no
 * localStorage, and that is correct - it must not fire there.
 */
export function describeWebStorageShadow(input: WebStorageShadowInput): string | null {
  if (input.documentType !== 'object') return null // not a DOM environment
  if (input.localStorageType !== 'undefined') return null // the DOM's storage is present
  const major = Number(input.nodeVersion.split('.')[0])
  const tell =
    input.sessionStorageType === 'object'
      ? ' (sessionStorage IS present, which is the signature of Node\'s Web Storage shadowing the DOM\'s)'
      : ''
  return (
    `localStorage is undefined inside a DOM test environment on Node ${input.nodeVersion}${tell}. ` +
    `Node ${major >= 25 ? 'ships' : 'may ship'} its own \`localStorage\` global (default-on since Node 25), ` +
    `which vitest's DOM environment does not replace - so every render suite that touches ` +
    `localStorage fails with "Cannot read properties of undefined". This is a Node VERSION problem, ` +
    `not a platform one: CI runs Node 22 (see .nvmrc / package.json#engines), where it passes. ` +
    `Fix: run the suite on Node 22 - \`nvm use\`, or without installing anything: ` +
    `\`npx -y node@22 node_modules/vitest/vitest.mjs run\`. ` +
    `(NODE_OPTIONS=--localstorage-file=<path> also makes the error disappear, but that hands the ` +
    `tests NODE's storage rather than happy-dom's, so it is not a fix.)`
  )
}
