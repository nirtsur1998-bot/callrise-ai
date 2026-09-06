// THE HOOK-ORDER GATE (2026-09-06). Found on the clean VM by the Stage 1
// re-walk: pressing the mic on the Live screen dropped the whole screen into
// the error boundary — React error #310, "rendered more hooks than during the
// previous render" — because LiveView's glance-HUD hooks (added that morning)
// sat AFTER an early-return block. The idle frame skipped them; the first
// frame after the click ran them.
//
// eslint-plugin-react-hooks was installed and configured the whole time and
// would have named all four lines. Nothing ran it: `npm run lint` is not in
// the verify-green gate, and cannot be — the repo carries ~4,900 lint errors
// of other kinds. So this test runs ONE rule, the one whose violations crash
// a screen at runtime, over every renderer component, and fails the suite
// on the first violation. Red-checked at birth by stashing the fix: 4 errors
// in LiveView.tsx, all named with their lines.
//
// Kept to the crash-class rule on purpose. Widening it to the rest of the
// plugin (purity, refs, set-state-in-effect …) is a separate, larger clean-up.
import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { join } from 'node:path'

const RULE = 'react-hooks/rules-of-hooks'
const RENDERER = join(__dirname, '..')

describe('react-hooks/rules-of-hooks across the renderer', () => {
  it('no component calls a hook conditionally or after an early return', async () => {
    // the project's own flat config (eslint.config.mjs) supplies the plugin
    // and already sets this rule to 'error'; only that rule's verdict is read
    const eslint = new ESLint({ cwd: join(RENDERER, '..', '..', '..'), cache: false })
    const results = await eslint.lintFiles([`${RENDERER.replace(/\\/g, '/')}/**/*.{ts,tsx}`])
    const violations = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === RULE)
        .map((m) => `${r.filePath.split(/[\\/]src[\\/]/)[1] ?? r.filePath}:${m.line}:${m.column} ${m.message}`)
    )
    expect(results.length, 'the glob matched no files — the gate lints nothing').toBeGreaterThan(50)
    expect(violations, violations.join('\n')).toEqual([])
  }, 300_000)
})
