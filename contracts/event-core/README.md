# Event Core (MVP)

This module provides a function-first event core for DDD + CQRS + event sourcing.

## Boundaries

- `domain.ts`: aggregate rehydration and decision contracts.
- `storage.ts`: persisted event contracts and command/audit/trace context.
- `transport.ts`: event shape for bus/transmission consumers.
- `codec.ts`: mapping between domain events and persisted records.
- `event-store.ts`: storage abstraction.
- `projector.ts`: read-model projection loop.
- Postgres adapter implementation lives in `infrastructure/event-core-postgres/`.

## Domain Event Rule

`DomainEvent` intentionally contains only:

- `type`
- `data`

All metadata (audit, trace, tenant, timing, version, global position) is stored in storage/transport contracts.

## Global Position

`globalPosition` is intentionally modeled as a canonical base-10 decimal string in the core contract.

This avoids precision loss because JavaScript `number` cannot safely represent unbounded Postgres `bigint` values.

Use these helpers from `storage.ts`:

- `ZERO_GLOBAL_POSITION`
- `parseGlobalPosition(...)`
- `globalPositionFromBigInt(...)`
- `compareGlobalPosition(...)`

Example:

```ts
import {
  ZERO_GLOBAL_POSITION,
  parseGlobalPosition,
  compareGlobalPosition,
} from "@chase-sets/event-core";
```

## Aggregate Snapshots

`AggregateRepositoryConfig.snapshots` (`aggregate-repository.ts`, wired up in
`aggregate-repository-internal.ts`) is an opt-in load-time cache for
aggregates whose streams accumulate enough events that full replay on every
command becomes the bottleneck (the marketplace listing aggregate, whose
reprice-heavy streams motivated this, is the first adopter). Adoption is
per-repository config, never global -- an aggregate that never sets
`snapshots` behaves exactly as it did before this feature existed.

Invariants, by design:

- **A snapshot is a pure cache, never a source of truth.** The event stream
  stays canonical. A snapshot store must always be safe to truncate or
  rebuild from events with zero data loss; `load()` transparently falls back
  to full replay whenever a snapshot is missing, unreadable, or fails a
  schema-version check -- it never throws for any of those cases.
- **Schema-versioned.** `snapshots.schemaVersion` must be bumped whenever
  `evolve`'s fold shape changes in a way that would make an old snapshot's
  stored state incompatible. A stored snapshot whose `schemaVersion` does not
  match is treated exactly like a missing snapshot.
- **Write-behind, never in the critical path.** `createCommandHandler`
  (`command-handler-internal.ts`) calls `repository.scheduleSnapshot(...)`
  only after a command's append has already committed, and never awaits it.
  A snapshot write failure is caught, reported to
  `snapshots.onSnapshotWriteFailed` if provided, and otherwise swallowed --
  it can never fail the command that triggered it.
- **Threshold is stateless.** A snapshot is scheduled when the post-command
  version crosses a multiple of `snapshots.everyNEvents`; there is no
  "read the last snapshot version back" round trip on the write path, so the
  policy is safe under concurrent writers and process restarts.
- **Commit-position/expected-version semantics are unchanged.** `append()`
  itself is untouched by this feature; snapshots only affect where `load()`
  starts folding from.

Postgres adapter: `infrastructure/event-core-postgres/aggregate-snapshot-store.ts`
(`createPostgresAggregateSnapshotStore`), backed by the
`event_store_aggregate_snapshots` table (one row per stream, replaced in
place, foreign-keyed to `event_store_streams` with `ON DELETE CASCADE`).

## Postgres Setup

Apply `infrastructure/event-core-postgres/schema.sql` before using Postgres adapters.

## Import Surface

Core contracts and composition helpers:

```ts
import { createAggregateCommandHandler, createProjector } from "@chase-sets/event-core";
```

Postgres adapters:

```ts
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
} from "@chase-sets/event-core-postgres";
```
