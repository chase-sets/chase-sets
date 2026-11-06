#!/usr/bin/env bash
set -euo pipefail
node ./scripts/run-workspaces.mjs test --exclude-test-profile=db --concurrency=4 --workspace-list="$UNIT_TEST_WORKSPACES" --shard=$UNIT_TEST_SHARD/2
node ./scripts/run-workspaces.mjs test:unit --test-profile=db --concurrency=4 --workspace-list="$UNIT_TEST_WORKSPACES" --shard=$UNIT_TEST_SHARD/2
