#!/usr/bin/env bash
set -euo pipefail

case "$1" in
  prepare)
    set -euo pipefail

    # The eight-file bootstrap DB partition runs with bounded
    # --maxWorkers=3, so up to ~3 x ~20 concurrent multi-context pools
    # each cascade-drop their schemas in beforeEach. max_locks_per_transaction
    # is a postmaster-start parameter: ALTER SYSTEM only stages the
    # change, the shared lock table isn't resized until the postmaster
    # restarts (a reload/SIGHUP is not sufficient), so this restarts the
    # service container and confirms the effective setting before any
    # DB-profile command runs.
    target_max_locks_per_transaction=512
    # 300 is bounded headroom, not an observed hosted peak. Workspace
    # concurrency stays 2; pools allocate clients on demand, not at max.
    target_max_connections=300

    free -m
    docker inspect --format 'Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} ShmSize={{.HostConfig.ShmSize}} (bytes; Memory=0 means no Docker limit)' "$POSTGRES_CONTAINER_ID"
    docker exec "$POSTGRES_CONTAINER_ID" sh -c '
      for setting in /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.high /sys/fs/cgroup/memory/memory.limit_in_bytes; do
        if [ -r "$setting" ]; then printf "%s=" "$setting"; cat "$setting"; fi
      done'

    docker exec "$POSTGRES_CONTAINER_ID" psql -U postgres -c \
      "ALTER SYSTEM SET max_locks_per_transaction = ${target_max_locks_per_transaction};"
    docker exec "$POSTGRES_CONTAINER_ID" psql -U postgres -c \
      "ALTER SYSTEM SET max_connections = ${target_max_connections};"
    docker restart "$POSTGRES_CONTAINER_ID"

    ready=false
    for _ in $(seq 1 30); do
      if docker exec "$POSTGRES_CONTAINER_ID" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
        ready=true
        break
      fi
      sleep 1
    done
    if [ "$ready" != "true" ]; then
      echo "PostgreSQL did not become ready within 30s after restart." >&2
      docker logs "$POSTGRES_CONTAINER_ID" >&2 || true
      exit 1
    fi

    effective="$(docker exec "$POSTGRES_CONTAINER_ID" psql -U postgres -tAc 'SHOW max_locks_per_transaction;' | tr -d '[:space:]')"
    if [ "$effective" != "$target_max_locks_per_transaction" ]; then
      echo "Expected max_locks_per_transaction=${target_max_locks_per_transaction} but Postgres reports ${effective}." >&2
      exit 1
    fi
    echo "PostgreSQL max_locks_per_transaction is now ${effective}."

    effective="$(docker exec "$POSTGRES_CONTAINER_ID" psql -U postgres -tAc 'SHOW max_connections;' | tr -d '[:space:]')"
    if [ "$effective" != "$target_max_connections" ]; then
      echo "Expected max_connections=${target_max_connections} but Postgres reports ${effective}." >&2
      exit 1
    fi
    echo "PostgreSQL max_connections is now ${effective}."
    docker exec "$POSTGRES_CONTAINER_ID" psql -U postgres -v ON_ERROR_STOP=1 -c \
      'SHOW max_connections; SHOW max_locks_per_transaction; SHOW shared_buffers; SHOW work_mem; SHOW maintenance_work_mem; SHOW superuser_reserved_connections; SHOW reserved_connections;'
    ;;
  select)
    if [[ "$DB_WORKSPACE_GROUP" != "api" ]]; then
      echo "selected=false" >> "$GITHUB_OUTPUT"
      exit 0
    fi
    if [[ -z "$AFFECTED_WORKSPACES" || ",$AFFECTED_WORKSPACES," == *",@chase-sets/app-platform-api,"* ]]; then
      echo "selected=true" >> "$GITHUB_OUTPUT"
    else
      echo "selected=false" >> "$GITHUB_OUTPUT"
    fi
    ;;
  diagnostics)
    mkdir -p "${RUNNER_TEMP}/db-profile-diagnostics"
    {
      echo 'Post-failure observation only; not failure-instant or peak attribution.'
      date -u +'%Y-%m-%dT%H:%M:%SZ'
      timeout 15s docker exec "$POSTGRES_CONTAINER_ID" psql -U postgres -v ON_ERROR_STOP=1 -c \
        'SHOW max_connections; SHOW max_locks_per_transaction; SHOW shared_buffers; SHOW work_mem; SHOW maintenance_work_mem; SHOW superuser_reserved_connections; SHOW reserved_connections;' || echo 'PostgreSQL settings unavailable.'
      timeout 15s docker exec "$POSTGRES_CONTAINER_ID" psql -U postgres -v ON_ERROR_STOP=1 -c \
        'SELECT datname, application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;' || echo 'PostgreSQL activity unavailable.'
    } > "${RUNNER_TEMP}/db-profile-diagnostics/post-failure.txt" 2>&1
    ;;
  *)
    echo "Unknown db-tests operation: $1" >&2
    exit 1
    ;;
esac
