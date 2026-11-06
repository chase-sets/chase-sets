#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  install)
    set -euo pipefail
    test -n "$AC4_SOURCE_SHA"
    test "$(git rev-parse HEAD)" = "$AC4_SOURCE_SHA"
    test "${CHASE_SETS_LANE_MODE+x}" != x
    printf 'AC4 source=%s run=%s attempt=%s job=%s\n' \
      "$AC4_SOURCE_SHA" "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$GITHUB_JOB"
    node scripts/playwright-chromium-install.mjs
    ;;
  prove)
    set -euo pipefail
    CHASE_SETS_HERMETIC_CHROMIUM=1 xvfb-run --auto-servernum \
      pnpm --filter @chase-sets/channels run test:unit \
      features/connector-client/integrations/order-authority-probe/capture.test.ts \
      -t 'host-attributed hermetic Chromium' \
      --maxWorkers=1 --no-file-parallelism \
      --reporter=verbose --reporter=json \
      --outputFile.json="$RUNNER_TEMP/ac4-chromium.json"
    node scripts/pr-checks/hermetic-chromium-receipt.mjs "$RUNNER_TEMP/ac4-chromium.json"
    ;;
  *)
    echo "Unknown capture-hermetic-chromium operation: $1" >&2
    exit 1
    ;;
esac
