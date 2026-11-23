#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  passive)
    test "$ARCIFY_PAIRED_RUN_MODE" = native-passive-scroll
    runner=scripts/.native-passive-scroll-runner.mjs
    output=test-results/native-passive-scroll ;;
  sticky)
    test "$ARCIFY_PAIRED_RUN_MODE" = move-drag
    runner=scripts/paired-chrome-smoke.mjs
    output=test-results/paired-chrome-move-drag ;;
  *) exit 64 ;;
esac
mkdir -p "$output"
capture_dist() {
  local receipt="$1"
  (cd dist && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > "$receipt"
  cmp scripts/native-passive-scroll-expected-dist.sha256 "$receipt"
}
capture_dist "$output/candidate-dist-before.sha256"
run_status=0
xvfb-run --auto-servernum node "$runner" "$2" 2>&1 | tee "$output/runner.log" || run_status=$?
capture_dist "$output/candidate-dist-after.sha256"
cmp "$output"/candidate-dist-{before,after}.sha256
exit "$run_status"
