#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  checkout)
    set -euo pipefail
    checkout_commit="$(git rev-parse --verify 'HEAD^{commit}')"
    checkout_tree="$(git rev-parse --verify 'HEAD^{tree}')"
    checkout_parents="$(git show -s --diff-merges=off --format=%P HEAD)"
    executed_base_sha="$(printf '%s\n' "$checkout_parents" | awk '{print $1}')"
    executed_base_tree="$(git rev-parse --verify "${executed_base_sha}^{tree}")"
    source_head_tree="$(git rev-parse --verify "${RESPONSIVE_EVIDENCE_SOURCE_HEAD_SHA}^{tree}")"
    {
      echo "checkout-commit=${checkout_commit}"
      echo "checkout-tree=${checkout_tree}"
      echo "checkout-parents=${checkout_parents}"
      echo "executed-base-sha=${executed_base_sha}"
      echo "executed-base-tree=${executed_base_tree}"
      echo "source-head-tree=${source_head_tree}"
    } >> "$GITHUB_OUTPUT"
    ;;
  cache)
    set -euo pipefail
    version="$(pnpm exec playwright --version | awk '{print $2}')"
    test -n "$version"
    browser_path="${RUNNER_TEMP}/playwright-chromium/${RUNNER_OS}/${RUNNER_ARCH}/${version}"
    echo "browser-path=${browser_path}" >> "$GITHUB_OUTPUT"
    echo "version=${version}" >> "$GITHUB_OUTPUT"
    echo "PLAYWRIGHT_BROWSERS_PATH=${browser_path}" >> "$GITHUB_ENV"
    ;;
  run)
    set -o pipefail
    pnpm run test:e2e:suite "$E2E_SUITE_BATCH" 2>&1 | tee "${RUNNER_TEMP}/responsive-evidence-producer.log"
    ;;
  *)
    echo "Unknown e2e-tests operation: $1" >&2
    exit 1
    ;;
esac
