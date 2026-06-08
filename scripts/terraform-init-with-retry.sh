#!/usr/bin/env bash
set -euo pipefail

attempts="${TERRAFORM_INIT_RETRY_ATTEMPTS:-5}"
base_delay_seconds="${TERRAFORM_INIT_RETRY_DELAY_SECONDS:-20}"
attempt=1

while true; do
  if terraform init "$@"; then
    exit 0
  fi

  status=$?
  if [ "$attempt" -ge "$attempts" ]; then
    echo "terraform init failed after ${attempts} attempts." >&2
    exit "$status"
  fi

  delay_seconds=$((base_delay_seconds * attempt))
  echo "terraform init failed on attempt ${attempt}/${attempts}; retrying in ${delay_seconds}s." >&2
  sleep "$delay_seconds"
  attempt=$((attempt + 1))
done
