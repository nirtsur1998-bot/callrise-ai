# The hollow-green taxonomy: which species have a mechanical tell

**M35 Stage 3, 2026-09-06.** The taxonomy lives in the vault (`03-Features/M26 - The Engine Room…`,
82 species at the time of writing). The milestone asked: *how many of them are expressible as a
test?* This is the honest answer, per species, in three columns. A species is **mechanised** only
when a file in this repo fails on it; **expressible** when a concrete check could be written and
is described here but is not built; **judgement** when the tell is a reading, not a computation.

**Count: 15 mechanised · 9 expressible, not built · 58 judgement.** Most of the catalogue is about
what a claim *means*, and no scanner reads meaning. The mechanised ones are the ones where the
failure has a *shape* in a file: an output line, an import, a byte, a step order.

## Mechanised — a file in this repo goes red on it

| # | Species | The tell, mechanically | Where |
|---|---|---|---|
| 4 | Green suite, stray error line | an `Errors  N error` line beside a passing count fails the verdict | `scripts/verification/verify-green.mjs`, `src/__tests__/verify-green.test.ts` |
| 9 | The hollow verification command | the CI gate must be the real command, run directly, in the right order | `src/__tests__/verify-workflow.test.ts` |
| 12 | The thoroughly-tested frozen module | a module whose header's first line says FROZEN / RETIRED / DEAD CODE has no production importer | `src/__tests__/frozen-modules-have-no-production-callers.test.ts` (found live: `segments.ts`) |
| 14 | The signal discarded in transit | exit code never sufficient; summary lines required; no pipe after the gate | `verify-green.test.ts`, `verify-workflow.test.ts` |
| 19 | The guard that fails at the one thing it was built for | the bundle's own mtime vs source, not the extraction's | `scripts/verify-bundle.sh` (fixed the day it was found) |
| 23 | Shipped as code, never as deployment | built-but-not-shipped report on a schedule | `.github/workflows/unshipped.yml`, `scripts/unshipped-report.mjs` |
| 41 | Tests before the build, gated tests skipped silently | build steps precede the suite; the four channel-swap tests are proven to have RUN, not merely to be named | `.github/workflows/release.yml` (BUG-120 step), `verify-workflow.test.ts` |
| 45 | The fix its own build pipeline undoes | what the packaged app ships is asserted, not what the source says | `src/__tests__/packaged-files.test.ts` |
| 48 | The test file that is never run and does not say so | every `*.test.ts*` under `src` matches the runner's include | `src/__tests__/no-uncollected-test-files.test.ts` |
| 53 | The fallback that succeeded at doing the wrong thing | a writing instrument names its target or refuses; the driver asserts the action changed state | `scripts/verification/state-guard.mjs`, `ui-driver.mjs` (`actAndExpectChange`), `state-guard-selftest.mjs` |
| 69 | The adjacent measurement | the answer is read from the suite's/typecheck's own lines; a bare `1` is not an error | `verify-green.test.ts`; the Stage 2 RDP driver refuses to click or capture when its window is not the one on top |
| 70 | The backslash that did not survive the journey | no control byte (0x00–0x1F except tab/LF/CR, 0x7F) in any source file | `src/__tests__/no-control-bytes-in-source.test.ts` |
| 77 | The heading that rots | headings carry no status; one `**Status:**` line; the index is generated; disagreement refuses the write | `scripts/verification/tracker-status.mjs`, `src/__tests__/tracker-status.test.ts` |
| 79 | The harness that can only fail | every instrument has a self-test that makes it refuse on purpose | `state-guard-selftest.mjs`, `verify-green.test.ts` (Errors rule removed → red), `tracker-status.test.ts` (planted closure → exit 2) |
| 80 | The push before the check finished | CI runs the full gate on every push; a premature push is caught by the same gate the session skipped | `.github/workflows/verify.yml` |

## Expressible — a concrete check exists on paper, not yet in the repo

| # | Species | The check that would express it | Why not tonight |
|---|---|---|---|
| 6 | The vacuous universal quantifier | lint: `expect(x.every(` / `.all(` in a test with no `length` / `toHaveLength` assertion on the same collection earlier in the block | heuristic; needs an AST pass to avoid false positives on named collections |
| 11 | The conformance suite that no-ops on its platform | a `describe` gated on `process.platform` must either assert the native addon loaded or `it.skip` with a reason string; scan test files for platform gates without one | needs agreement on the reason-string convention first |
| 17 | The flag set in one place and reset in another | AST scan: a local boolean assigned `true` in one branch and unconditionally assigned a constant later in the same function | an AST tool (ts-morph) not currently a dependency |
| 18 | The stale doc in the privileged position | `CLAUDE.md` carries a `Last verified` date; a test fails when it is older than N days | the app repo's `CLAUDE.md` has no such line yet; the driver repo's does — a convention to adopt, then trivial |
| 32 | The claim that expired | dated claims (`verified 2026-…`) older than N days in docs are listed as "re-verify or retire" | a sweep with a report, not a pass/fail; needs the marker convention |
| 35 | The stale closure that silently redirects | `react-hooks/exhaustive-deps` as an error, not a warning | the plugin is wired in `eslint.config.mjs`; promoting the rule is a one-line decision the founder should make with the lint noise in front of them |
| 46 | The absence test that named one hiding place | an absence guarantee's test enumerates the container (directory / route set), not the filenames it knows | per-guarantee; the BUG-139 sweep tests do this, a repo-wide rule needs each guarantee named |
| 47 | The config string that fails open | every string-literal id crossing a module boundary (job types, IPC channels, event names) resolves to a registered one | needs a registry to check against; the Activity-feed policy test does it for one boundary |
| 57 | The comment that carries a guarantee, coupled to a check | a `GUARANTEE:` comment marker must sit within N lines of an `expect`/`assert` naming the same thing | a convention to adopt, then a scan |

## Judgement — the tell is a reading, and a scanner cannot make it

1, 2, 3, 5, 7, 8, 13, 15, 16, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 31, 33, 34, 36, 37, 38, 39,
40, 42, 43, 44, 49, 50, 51, 52, 54, 55, 56, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 71, 72, 73,
74, 75, 76, 78, 81, 82.

What they have in common: the failure is in what a true observation is taken to *mean* (40, 51,
59, 62, 73), in what a check was pointed *at* (7, 21, 22, 25, 63, 74), in a decision that was
reasonable and wrong (34, 43, 44, 67, 71), or in the world changing under a claim (16, 24, 32's
cousins). The checklist form of the taxonomy — the trigger index at the top of the vault note —
is the instrument for these, and the standing rule stays: **verify a check can FAIL before
trusting that it passes** (rule 5 of `CLAUDE.md`), which is the only universal tell there is.

## How to add one

A species becomes mechanised when (1) a file in `src/__tests__/` or `scripts/verification/`
fails on it, (2) that file was watched going red on a planted instance before it was trusted, and
(3) this table names the file. Move the row up; keep the count at the top honest.
