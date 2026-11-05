#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  controls)
    python3 scripts/provider-object-disposition/browser-boundary/ownership.test.py
    python3 scripts/provider-object-disposition/browser-boundary/ownership-race.test.py
    python3 scripts/provider-object-disposition/browser-boundary/identity-controls.test.py
    python3 scripts/provider-object-disposition/browser-boundary/native-variants.test.py
    python3 scripts/provider-object-disposition/browser-boundary/peer-observe.test.py
    python3 scripts/provider-object-disposition/browser-boundary/ownership-stimulus.test.py
    python3 scripts/provider-object-disposition/browser-boundary/path-stimulus.test.py
    python3 scripts/provider-object-disposition/browser-boundary/path-fixtures.py
    python3 scripts/provider-object-disposition/browser-boundary/pid-reuse.test.py
    python3 scripts/provider-object-disposition/browser-boundary/r3-stimulus.test.py
    python3 scripts/provider-object-disposition/browser-boundary/installer-failure.test.py
    pnpm exec vitest run --config vitest.scripts.config.mjs scripts/provider-object-disposition/test-window-policy.test.mjs scripts/provider-object-disposition/browser-boundary/bootstrap.test.mjs scripts/provider-object-disposition/browser-boundary/protocol.test.mjs
    pnpm exec vitest run --config vitest.scripts.config.mjs scripts/provider-object-disposition/test-window-admission.test.mjs scripts/provider-object-disposition/test-window-main.test.mjs scripts/provider-object-disposition/test-window-driver.test.mjs scripts/provider-object-disposition/test-window-packet.test.mjs scripts/provider-object-disposition/publish-test-window.test.mjs scripts/provider-object-disposition/browser-boundary/installation-cycle.test.mjs scripts/provider-object-disposition/browser-boundary/browser-lifecycle-controls.test.mjs
    node scripts/provider-object-disposition/browser-boundary/hosted-controls.mjs
    ;;
  require-source)
    test "$SOURCE_RESULT" = success
    ;;
  *)
    echo "Unknown static-checks operation: $1" >&2
    exit 1
    ;;
esac
