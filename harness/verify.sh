#!/usr/bin/env bash
# ORCH-P verification gate — the only definition of "done" for this repository.
#   ./harness/verify.sh               syntax, tests, secret scan, whitespace, links
#   ./harness/verify.sh --container   also: verification image freshness + isolation probe
# Evidence: runs/<timestamp>/<step>.log. Each step's real exit code decides the result.
set -uo pipefail
cd "$(dirname "$0")/.."

RUN_DIR="runs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN_DIR"
fail=0
step() {
  local name="$1"; shift
  echo "──► $name"
  if "$@" >"$RUN_DIR/$name.log" 2>&1; then
    echo "    ✔ $name"
  else
    echo "    ✘ $name FAILED (exit $?) — see $RUN_DIR/$name.log"
    tail -n 20 "$RUN_DIR/$name.log" | sed 's/^/      /'
    fail=1
  fi
}

SECRET_PATTERN='-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{20,}'

step "syntax" bash -c 'for f in $(git ls-files "*.mjs"); do node --check "$f" || exit 1; done'
step "tests" node --test tests/orchestrate.test.mjs tests/verify-container.test.mjs
step "secret-scan" bash -c "! git grep -nE -- '$SECRET_PATTERN' -- . ':!harness/verify.sh'"
step "whitespace" bash -c 'git diff --check HEAD && git diff --check --cached'
step "links" node harness/check-links.mjs
if [ "${1:-}" = "--container" ]; then
  step "container-probe" node verify-container/run-gate.mjs probe .
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "VERIFICATION FAILED — the task is NOT done. Evidence: $RUN_DIR/"
  exit 1
fi
echo "VERIFICATION PASSED — task may be marked done. Evidence: $RUN_DIR/"
