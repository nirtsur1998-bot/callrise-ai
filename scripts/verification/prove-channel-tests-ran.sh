#!/bin/bash
# BUG-120, second half — shared by the Windows and macOS release jobs.
#
#   bash scripts/verification/prove-channel-tests-ran.sh <path/to/test.log>
#
# Reordering "build before test" is not self-verifying: a green run looks
# IDENTICAL whether the four build-gated channel tests ran and passed, or were
# skipped again. The tally lives in the verbose vitest log, which is only
# surfaced on failure -- so on success there was nothing to read. That is the
# same hollow-green shape the reorder existed to close, landing on the fix
# itself.
#
# NAMES, NOT COUNTS -- and PASSED, not merely PRINTED. The first draft of this
# check grepped for the four test names and passed. It was wrong: vitest
# --reporter=verbose prints SKIPPED tests by name too, marked with a
# down-arrow instead of a check. So the check reported "4 of 4 found" while
# all four were skipped. Caught by hiding the built worklet and watching the
# check pass anyway.
#
# Markers are matched as explicit BYTES via printf, not as literals in this
# file, so the check cannot break if the file's encoding is ever normalised.
#
# It runs only after the test step succeeds, so it can never mask an ordinary
# test failure -- it answers "did these four execute", not "did the suite
# pass". A release that silently loses the channel verification is exactly
# what BUG-120 was, so a miss FAILS the release rather than merely warning.
set -u
LOG="${1:?usage: prove-channel-tests-ran.sh <test.log>}"
[ -f "$LOG" ] || { echo "::error::$LOG does not exist"; exit 1; }

PASS_MARK=$(printf '\xe2\x9c\x93')   # U+2713 check  -> ran and passed
SKIP_MARK=$(printf '\xe2\x86\x93')   # U+2193 arrow  -> collected but skipped

echo "--- suite tally (compare the TOTAL; skip counts are environment-dependent) ---"
grep -E "Test Files|Tests " "$LOG" | tail -4 || true
echo ""
echo "--- the four build-gated worklet tests ---"
ran=0
for pat in \
  "loads successfully from the built renderer output" \
  "passes the channel self-test" \
  "mono mode: real worklet emits only channel 0" \
  "proves the self-test actually detects a swap"
do
  line=$(grep -F "$pat" "$LOG" | head -1)
  if [ -z "$line" ]; then
    echo "  NOT COLLECTED : $pat"
  elif printf '%s' "$line" | grep -qF "$SKIP_MARK"; then
    echo "  SKIPPED       : $pat"
  elif printf '%s' "$line" | grep -qF "$PASS_MARK"; then
    echo "  RAN + PASSED  : $pat"
    ran=$((ran + 1))
  else
    echo "  UNKNOWN STATE : $line"
  fi
done

echo ""
echo "channel-swap tests that actually ran: $ran of 4"
if [ "$ran" -ne 4 ]; then
  echo "::error::BUG-120 has regressed - the channel-swap tests did not run."
  echo "electron-vite build must run BEFORE vitest, or real-worklet-render.test.ts"
  echo "skips itself (it is gated on out/renderer/assets/pcm-processor*)."
  exit 1
fi
