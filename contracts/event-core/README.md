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

## Acknowledged Configuration Epochs

Class-C owner configuration uses an acknowledged epoch closure protocol. A
fully-qualified key is `OPEN(e)` at one source store incarnation. The business
writer records `CLOSING(e, topology)` in its own transaction using
`beginClosureInTransaction`. New grants stop on that key, but existing grants
can still commit until the consumer receives `CLOSED-THROUGH(e)`.

`driveClosure` writes each consumer's canonical guard journal under its local
EXCLUSIVE transaction lock, then records the durable receipt in the source
journal. `installClosureInTransaction` permits the owner's business change
only after all receipts; its `APPLIED(e)` record opens `e+1` in that same
transaction. Lost replies and unavailable stores remain pending or blocked;
restart the driver against the same journal. Elapsed time releases nothing.

Grant capture checks registered consumer identity under the source SHARED
guard. Terminal `appendToStreams` takes ordered consumer-local SHARED key
locks, then sorted stream locks, then the global append lock. It reads only
consumer-local histories and the consumer database clock after locking and
holds the locks through COMMIT. An absent history admits only the named
creation epoch and consumer incarnation; partial histories refuse. Canonical
journal anchors and linked records detect missing, changed and corrupt history.
Terminal validation uses one consumer-local SQL read per key for isolation,
lock ownership, store identity, canonical history and clock, with at most 32 keys.

Registration and retirement refuse while CLOSING. Registration at a later
epoch initializes the new consumer closed-through; retirement fences all old
grants before removing membership. Every participation query uses a bounded
timeout. No-grant callers retain their existing behavior. Single-stream and
independent append APIs refuse class-C grants; they cannot silently bypass the
atomic adapter. The in-memory critical section validates synchronously without
await between version pre-check, snapshot, append and restore.

## Owner-Stream Reservations

Owner-stream reservations are owner-local promises, distinct from an
Owner-Stream Seal (the canonical owner-state version). A reservation captures
the consumer request identity, seal version and store incarnation, target and
full-command fingerprint. New reservations stop behind a durable invalidation
intent. The consumer-local Request Terminal is the only commit fence: its
guarded CAS is OPEN -> COMMITTED or OPEN -> ABORTED, and a reservation releases
only from that original terminal. Unknown outcomes remain open and blocking;
elapsed time, TTL, cache misses and lost replies never release a reservation.
The live manifest is bounded to 8 purposes, 32 resources per operation and 128
live grants per resource. Inbound evidence is recorded before conflict
settlement and reports PENDING or BLOCKED rather than being discarded.

Capture each reservation inside the owner's transaction, then prepare the
consumer terminal with the complete immutable manifest. Preparation checks
the captured reservations; the atomic append checks only that local record.
Only `appendToStreams` can commit. Failed preparation can create an original
ABORTED terminal through the abort port; a preparation deadline invokes that
same CAS, never owner-side expiry. The recovery driver requests abort outside
owner locks, reconciles exact original terminals, then generation-fences the
writer's effective change and APPLIED status in one owner transaction.

The PostgreSQL adapter's `applyInvalidation` and `applyInboundEvidence` ports
write through the supplied owner transaction. Inbound payloads are durably
recorded as PENDING before settlement. A pending resource refuses new grants;
inbound settlement reports BLOCKED for unknown terminals. Settlement resumes from canonical records,
applies the evidence and marks APPLIED atomically, and is repeatable without
applying twice. The memory adapter uses synchronous equivalents and the
existing EventStore snapshot/append/restore section, with no intervening await.

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
