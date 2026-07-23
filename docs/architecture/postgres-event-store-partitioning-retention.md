# Postgres Event Store Partitioning And Retention

## Status

Accepted plan. Physical DDL is deferred until the migration ledger, advisory lock, and concurrent-index model in #2843 is in place.

## Context

`event_store_events` is the append-only source of truth for bounded-context facts. The table currently uses `global_position bigserial` as the primary ordered cursor, keeps `event_id` globally unique, and stores stream, tenant, context/category, event type, JSON payload, metadata, occurrence time, and recording time. Projection checkpoints and wake recovery use global-position cursors; stream rehydration uses `(stream_id, stream_version)`.

Current hot read shapes:

- `readStream` loads one stream by `stream_id`, `stream_version >= fromVersion`, ordered by `stream_version`.
- `readAll` and projection subscriptions load the global tail with `global_position > checkpoint`, optional tenant, event-type, and stream-prefix filters, ordered by `global_position`.
- source-head and lag checks use `MAX(global_position)` and counts after a global-position checkpoint.

The existing index set is therefore global-position first for tail reads, with composite filters that preserve global-position ordering.

## Decision

Partition `event_store_events` by range on `global_position`, not by `recorded_at`.

Use coarse, append-only global-position ranges sized from production ingest evidence. Start with a default/open-ended active partition and roll forward by adding future ranges before the active range is hot. Partition names should encode zero-padded inclusive/exclusive position bounds, for example `event_store_events_p000000000000_000001000000`.

Keep `recorded_at` as an archival and operator reporting dimension inside each range partition, not as the partition key.

## Why Global Position

Global-position range partitioning matches the correctness cursor:

- projection catch-up already asks for events after a checkpoint and orders by `global_position`;
- wake relay catch-up and reconciliation drills prove convergence against event-store head positions;
- pruning old cold partitions can be gated by every durable consumer checkpoint passing the partition upper bound;
- append locality stays concentrated in the active high-position partition.

Time partitioning is easier to explain to operators, but it does not match the dominant query predicate. A `recorded_at` partition key cannot prune old partitions for `global_position > checkpoint` unless every query also carries a trustworthy time bound, and that would make correctness depend on clock-derived metadata instead of the durable cursor. It also makes late, replayed, or clock-skewed rows harder to reason about.

Tradeoffs of global-position ranges:

- retention windows are expressed as cursor cutoffs first and calendar age second;
- operators need a small lookup query to map a position range to recorded-at min/max timestamps;
- partition sizing must be adjusted from observed event volume rather than fixed monthly calendar partitions.

Those tradeoffs are acceptable because all freshness, replay, and projection safety rules already speak in global positions.

## Snapshot, Archive, And Retention Story

The event log remains append-only in the primary database while any online consumer can still need the rows.

Before detaching or dropping a cold partition, all of these must be true:

- every projection checkpoint, subscription checkpoint, relay cursor, rebuild cursor, and durable recovery cursor that can read the source database is greater than or equal to the partition upper bound;
- no active or retrying poison-event or blocked-stream row references a global position inside the partition;
- the partition has been exported to cold storage and the export has row counts, min/max global positions, min/max recorded timestamps, checksum metadata, and restore instructions recorded in the release evidence;
- restore has been tested in a non-production database for at least one representative partition format.

Retention is therefore detach-then-archive, not in-place `DELETE`. A detached partition should stay in the primary cluster for an operator grace period before archival-only retention, so rollback does not require an immediate cold restore.

Snapshots are not required for normal stream rehydration today because current streams are expected to remain bounded and `readStream` is indexed by `(stream_id, stream_version)`. Add stream snapshots only when production evidence shows a long-lived stream class whose rehydration regularly crosses the page-size limit or violates route/worker budgets. Snapshot rows must be owned by the bounded context that owns the aggregate behavior; shared infrastructure may provide storage helpers but must not infer snapshot semantics from stream names.

## Implementation Plan

Do not convert the table in boot-time schema SQL.

Physical partitioning should land as explicit migrations after #2843 provides:

- an applied-migration ledger;
- a Postgres advisory lock around boot-time migration coordination;
- out-of-transaction `CREATE INDEX CONCURRENTLY` support;
- one-time backfills that are recorded in the ledger instead of being re-run on every boot.

The migration design must preserve the current constraints:

- `(stream_id, stream_version)` remains unique for optimistic stream concurrency;
- `global_position` remains the total ordering cursor;
- `event_id` remains globally unique. Postgres partitioned-table unique constraints must include the partition key, so preserving global `event_id` uniqueness requires either an event-id registry table or another explicit design reviewed with the #2843 migration work.

Recommended migration sequence:

1. Add migration-ledger support and concurrent-index primitives under #2843.
2. Add an empty partitioned replacement table with the final indexes and constraints.
3. Dual-write or lock-and-copy only while the table is still small enough for the chosen maintenance window.
4. Validate row counts, min/max global positions, stream-version uniqueness, event-id uniqueness, and projection catch-up from a restored checkpoint.
5. Swap names in one ledgered migration and keep the old table read-only until rollback expiry.

## Operator Checks

Quarterly, and before public launch, record:

- total `event_store_events` rows;
- `MIN(global_position)`, `MAX(global_position)`, `MIN(recorded_at)`, `MAX(recorded_at)`;
- largest streams by row count;
- oldest projection/subscription checkpoint per source context;
- active poison-event and blocked-stream minimum global position;
- estimated active partition size at current ingest rate.

Those checks decide the next partition range size and whether any stream class needs snapshots.

`Platform Postgres Growth Evidence` collects the same posture in a weekly support-safe artifact for every context database. The workflow pulls database URLs from Terraform state, runs read-only `pg_catalog` and statistics queries, warns when connection utilization reaches 80% of `max_connections`, and uploads `postgres-growth-evidence/v1`.

The artifact includes database size, table count, estimated live/dead row totals, largest relation sizes, vacuum/analyze timestamps, and event-store high-water position when `event_store_events` exists. It deliberately excludes row samples, query text, connection strings, account/order/provider identifiers, emails, and payload bodies.

Use the artifact to decide when a table needs retention, partitioning, index review, or a follow-up capacity issue. A warning means one or more database collections failed and should be inspected without exposing database URLs.

`Platform Postgres Slow Query Digest` complements the growth artifact when managed Postgres already exposes `pg_stat_statements`. It uploads `postgres-slow-query-digest/v2` with hashed query fingerprints and aggregate timing/block counters only; it never emits raw query text, bind values, literals, customer/provider/account/session/order identifiers, emails, URLs, payloads, tokens, or secrets. A least-privilege role denied an optional posture setting (e.g. `shared_preload_libraries`) still yields extension/view/digest evidence; only a genuine zero-coverage run (no database collected) fails closed.

The digest workflow does not enable `pg_stat_statements`. Enabling the extension can require managed-database settings and `CREATE EXTENSION`, so coordinate that posture with #3626/#3627 and the migration-ledger work instead of adding boot-time DDL to deployables.
