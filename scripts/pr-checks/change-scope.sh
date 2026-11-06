#!/usr/bin/env bash
set -euo pipefail
if [ "$PR_SCOPE_EVENT_NAME" = "pull_request" ]; then
  base="$PR_SCOPE_PR_BASE"
  head="$PR_SCOPE_SHA"
elif [ "$PR_SCOPE_EVENT_NAME" = "merge_group" ]; then
  base="$PR_SCOPE_MERGE_BASE"
  head="$PR_SCOPE_MERGE_HEAD"
else
  base="$PR_SCOPE_BEFORE"
  head="$PR_SCOPE_SHA"
fi

if [ -z "$head" ]; then
  head="$PR_SCOPE_SHA"
fi
if [ -z "$base" ]; then
  base="$(git rev-parse origin/main)"
fi

if [[ "$base" =~ ^0+$ ]]; then
  base="$(git rev-list --max-parents=0 "$head")"
fi

first_parent=""
if [ "$PR_SCOPE_EVENT_NAME" = "pull_request" ] || [ "$PR_SCOPE_EVENT_NAME" = "merge_group" ]; then
  first_parent="--first-parent"
fi

node ./scripts/change-scope.mjs github-output --base="${base}" --head="${head}" $first_parent
