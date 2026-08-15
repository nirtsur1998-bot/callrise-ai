#!/usr/bin/env bash
#
# Bundle-level verification: confirms each fix is present in what SHIPS, not
# merely in source. Run after `npm run build:win -- --publish never`:
#
#   bash scripts/verify-bundle.sh
#
# It finds and extracts the asar ITSELF, deliberately — see the staleness
# note below for what happened when it accepted a pre-extracted directory.
#
# ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────
# Source-level review has been insufficient on this project before: 1.2.0
# nearly shipped without BUG-058's fix present in the packaged output. Every
# release since is checked by extracting the real app.asar and reading the
# compiled code.
#
# ── WHY IT REFUSES TO RUN ON A STALE ARTIFACT ────────────────────────────
# That check is worthless if it runs against yesterday's build, and that is
# not hypothetical. During 1.3.0 a rebuild FAILED — a running app held a
# native module, EPERM on unlink — while the surrounding tooling reported
# success, because the command ended `; echo "BUILD EXIT: $?"`: the trailing
# echo became the last command and replaced the build's verdict. Only the
# unchanged .exe timestamps gave it away. One trusted notification away, this
# script would have passed every assertion against the PREVIOUS build's asar
# and reported a version verified that had never been built.
#
# Two independent routes to the same catastrophic outcome — a source review
# that misses the bundle, and a bundle check that reads a stale bundle — mean
# the defence belongs HERE, at the verification step, rather than in
# remembering to write command lines carefully.
#
# The gate itself then got this wrong on its first draft, which is worth
# keeping: it timestamped the EXTRACTED DIRECTORY, so extracting a months-old
# asar one second ago read as "fresh", and it printed "safe to verify" over an
# artifact predating the entire change set. It now stats the .asar file, and
# owns the extraction so a caller cannot point it at the wrong thing.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASAR="${1:-$REPO/dist/win-unpacked/resources/app.asar}"
fail=0

if [ ! -f "$ASAR" ]; then
  echo "REFUSING: no packaged asar at $ASAR — build first." >&2
  exit 3
fi

# ── Staleness gate ───────────────────────────────────────────────────────
# A HARD REFUSAL (exit 3, distinct from a findings failure) rather than a
# warning: a warning printed above a wall of PASS lines is the same species
# of problem this whole file exists to prevent.
artifact_ts=$(stat -c %Y "$ASAR" 2>/dev/null)
# Only files that actually END UP in the bundle. Test files are excluded
# deliberately: none of them are packaged, so their mtimes say nothing about
# whether the artifact is current. Including them made the gate refuse a
# perfectly good build merely because a test was edited while it ran — a
# refusal for the wrong reason, which trains people to override the gate,
# which is how a gate stops working at all.
newest_src=$(find "$REPO/src" "$REPO/package.json" -type f \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' \) \
  -not -path '*/__tests__/*' -not -name '*.test.ts' -not -name '*.test.tsx' \
  -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1)
newest_src_ts=${newest_src%% *}
newest_src_path=${newest_src#* }

if [ -z "$artifact_ts" ] || [ -z "$newest_src_ts" ]; then
  echo "REFUSING: could not determine artifact or source timestamps." >&2
  exit 3
fi

if awk "BEGIN{exit !($newest_src_ts > $artifact_ts)}"; then
  echo "=================================================================="
  echo "  REFUSING TO VERIFY - THE ARTIFACT IS OLDER THAN THE SOURCE"
  echo "=================================================================="
  echo
  echo "  Newest source : $newest_src_path"
  echo "  Artifact      : $ASAR"
  echo
  echo "  The build did not produce this artifact. Most likely it FAILED and"
  echo "  something downstream reported success anyway - read the build's own"
  echo "  exit code, not a summary line and not a notification."
  echo
  echo "  Verifying now would report this version as checked when it was"
  echo "  never built. Rebuild first."
  exit 3
fi

echo "Artifact is newer than all source - safe to verify."
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
if ! npx asar extract "$ASAR" "$OUT" >/dev/null 2>&1; then
  echo "REFUSING: could not extract $ASAR" >&2
  exit 3
fi
echo

chk_present() { # label, pattern, subpath
  if grep -rqF "$2" "$OUT/$3" 2>/dev/null; then
    echo "  PASS  present: $1"
  else
    echo "  FAIL  MISSING: $1  (looked for: $2)"; fail=1
  fi
}

chk_absent() {
  # Comment-aware. electron-vite does NOT strip comments from the main
  # bundle, so a plain grep matches the explanatory comment that says "this
  # REPLACES the old dead id" and reports a correct bundle as broken. The
  # first version did exactly that and cried wolf - a verifier that fails on
  # a good build is as useless as one that passes on a bad one.
  if grep -rnF "$2" "$OUT/$3" 2>/dev/null | grep -qvE ':\s*(//|\*|/\*)'; then
    echo "  FAIL  STILL PRESENT IN CODE: $1  (found: $2)"; fail=1
  else
    echo "  PASS  absent from code: $1"
  fi
}

echo "=== main process ==="
# The 1.2.6 fix itself: consent cleared at call end.
chk_present "1.2.6 clears consent at call end"      "clearActiveConsent"          out/main
# STRUCTURAL, not comment-based. This build config strips comments from
# out/main (the 1.3.0 build did not, which is exactly why an assertion that
# greps for comment text is not portable between them). The compiled endCall
# reads `current = null;` then `clearActiveConsent();` — a sequence that
# survives bundling and genuinely distinguishes fixed from unfixed, since
# clearActiveConsent on its own was always present elsewhere in the file.
if grep -Pzoq 'current = null;\n  clearActiveConsent\(\);' "$OUT/out/main/index.js" 2>/dev/null; then
  echo "  PASS  present: 1.2.6 clear is INSIDE the call-end path"
else
  echo "  FAIL  MISSING: 1.2.6 clear is not in the call-end path"; fail=1
fi
# The corrected comment — proves the false claim is gone from what ships.
chk_absent  "1.2.6 false 'cleared as the call ended' claim gone" "the record being cleared as the call ended" out/main
# 1.2.5's own privacy fixes must still be present — this is a hotfix ON TOP
# of them, and a branch cut from the wrong base would silently drop them.
chk_present "1.2.5 journal redaction sweep still present" "redactPendingClosedJournals" out/main
chk_present "1.2.5 askCoach consent gate still present"   "consentPermitsCapture"       out/main

echo "=== renderer ==="
# NOT ASSERTED, and stated rather than quietly omitted.
#
# The renderer half of this fix — all three arm paths refusing to arm when
# the consent persist failed — is a control-flow change with no new string
# literal, and the renderer bundle IS minified. There is nothing to grep for
# that would distinguish the fixed build from the broken one. Asserting on
# something incidental that happens to survive minification would be a check
# that passes either way, which is worse than no check.
#
# It is covered instead by src/main/__tests__/consent-lifetime.test.ts, which
# drives the real IPC handlers and the real display-media grant callback, and
# was red-checked: reverting the fix fails exactly the three leak tests while
# the normal-flow and restart tests keep passing.
echo "  SKIP  renderer arm-path guards - minified, no greppable signature (see note in this script)"

echo
if [ "$fail" -eq 0 ]; then
  echo "BUNDLE VERIFICATION: ALL PASS"
else
  echo "BUNDLE VERIFICATION: FAILURES ABOVE"
fi
exit $fail
