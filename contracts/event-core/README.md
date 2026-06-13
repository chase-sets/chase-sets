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
