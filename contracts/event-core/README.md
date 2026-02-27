# Event Core (MVP)

This module provides a function-first event core for DDD + CQRS + event sourcing.

## Boundaries

- `domain.ts`: aggregate rehydration and decision contracts.
- `storage.ts`: persisted event contracts and command/audit/trace context.
- `transport.ts`: event shape for bus/transmission consumers.
- `codec.ts`: mapping between domain events and persisted records.
- `event-store.ts`: storage abstraction.
- `projector.ts`: read-model projection loop.
- `postgres/`: Postgres adapter implementation (`event-store.ts`, `projection-store.ts`, `types.ts`, `schema.sql`).

## Domain Event Rule

`DomainEvent` intentionally contains only:

- `type`
- `data`

All metadata (audit, trace, tenant, timing, version, global position) is stored in storage/transport contracts.

## Postgres Setup

Apply `postgres/schema.sql` before using Postgres adapters.

## Import Surface

Core contracts and composition helpers:

```ts
import { createCommandHandler, createProjector } from "../contracts/event-core";
```

Postgres adapters:

```ts
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
} from "../contracts/event-core/postgres";
```
