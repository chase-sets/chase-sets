# Event-Store Wake Notifications

## Purpose

Event-store wake notifications are the first source-side signal in the push-driven projection runtime. They let the active worker-owned relay know that a source context has committed new durable event rows, without making Postgres notifications the source of truth.

The durable event-store rows remain authoritative. A missed, duplicate, delayed, or out-of-order notification must be recoverable by replaying from the source event-store position.

## Emission Contract

`createPostgresEventStore` can emit a wake notification when `wakeNotifications.enabled` is true. The notification is disabled by default.

The append path writes event rows and updates the stream version inside the append transaction. After `COMMIT` succeeds, it sends one notification on the same checked-out client:

```sql
SELECT pg_notify($1, $2)
```

If the post-commit notification query fails, the append still succeeds. The observer receives `notificationFailed`, and the relay or fallback scanner must recover from durable event-store rows. This prevents callers from retrying a write that has already committed.

Rollout wiring must enable this consistently across staging and production by environment-specific config. The primitive alone does not mean every bounded-context service factory is already emitting wakes.

## Channel

Default channel:

```text
platform_event_store_commits
```

The channel can be overridden for environment or proof-mode isolation, but it must match the Postgres-safe channel pattern:

```text
^[A-Za-z_][A-Za-z0-9_]{0,62}$
```

Only the active worker-owned relay should hold direct or session-compatible `LISTEN` connections for these source-context channels. API routes and ordinary write traffic continue to use query pools.

## Envelope

The payload uses the same versioned work-signal envelope shape as the platform composite:

```json
{
  "schemaVersion": 1,
  "payloadVersion": 1,
  "kind": "event-store.commit",
  "source": "event-core-postgres",
  "emittedAt": "2026-06-10T12:00:00.000Z",
  "correlationId": "trace_1",
  "payload": {
    "sourceContextName": "checkout",
    "streamCategory": "checkout.checkout-session",
    "firstGlobalPosition": "101",
    "lastGlobalPosition": "102",
    "eventCount": 2,
    "eventTypes": ["checkout.session.created", "checkout.session.guest-attached"]
  }
}
```

`lastGlobalPosition` is the source-scoped cursor the relay uses to catch up from durable rows. `eventTypes` and `streamCategory` are hints for interest-index filtering. Consumers must still verify durable source rows.

## Privacy And Size

The notification must not include event payloads, metadata, stream IDs, tenant IDs, account IDs, user IDs, guest email, payment data, provider private payloads, phone numbers, addresses, secrets, or raw provider payloads.

The default serialized envelope cap is 4 KiB. Oversized or unsafe notifications are rejected before `pg_notify`; the durable event append remains committed.

## Relay Expectations

The relay must:

- Treat notifications as at-least-once wake hints.
- Read source event-store rows after its durable source cursor.
- Handle missed, duplicate, delayed, and out-of-order notifications.
- Coalesce work into the control-plane wake store.
- Use fallback scanning or reconciliation so relay downtime does not strand projections.
- Preserve projection leases, fencing, ledgers, poison handling, statement timeouts, and checkpoint truth.

## Structure Guardrail

`infrastructure/event-core-postgres/event-store.ts` is an approved lower-level direct `pg_notify` exception because `@chase-sets/platform-runtime` already depends on `@chase-sets/event-core-postgres`. Importing the composite from the event-store package would create a package cycle.

The exception is narrow: event-store append may emit composite-compatible `event-store.commit` envelopes after commit. Other direct `pg_notify`, `LISTEN`, or `UNLISTEN` usage must go through the platform work-signal composite or carry an explicit reviewed disposition.
