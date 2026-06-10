# Projection Wake Relay

## Purpose

The projection wake relay is the worker-owned bridge between source event-store wake hints and durable projection work. It keeps `pg_notify` cheap and non-durable while ensuring accepted projection work is represented in the control-plane work-signal store before ordinary workers or API waiters depend on it.

This document describes the relay fan-out core shipped for Milestone #19. Active source database `LISTEN` connections, source cursor persistence, active/standby lease election, and durable source catch-up are separate #1242 follow-up slices gated by the connection topology and budget work.

## Current Fan-Out Core

The `@chase-sets/platform-runtime/projection-wake-relay` module owns the pure fan-out path:

1. Parse and validate the event-store wake notification envelope.
2. Check the source context against the source-context wake relay config.
3. Map the wake through the projection interest index.
4. Create source-scoped projection wake intent inputs.
5. Enqueue/coalesce those intents through the durable work-signal store.

The function is intentionally callable by a future active listener, reconciliation scanner, or proof-mode harness without duplicating fan-out logic.

## Boundaries

Durable truth remains outside the notification:

- Source event-store rows remain the durable source of committed facts.
- Projection checkpoints remain the durable source of projection readiness.
- The control-plane wake store owns accepted wake intents, coalescing, claim state, retry, and cleanup.

The fan-out core does not claim that a source position has been fully caught up. It only converts a valid wake hint into durable work for interested projections. Relay high-water cursor advancement must happen only after the later relay catch-up slice verifies durable source rows and successful wake-store fan-out.

## Rollout Gate

Default runtime behavior is disabled. `listSourceContextWakeRelayConfigs()` returns only source contexts whose registry entry has relay fan-out enabled. The same registry entry also controls write-side event-store wake emission, so a source context should not produce unexplained notifications or listen-only fan-out.

Production enablement still requires:

- staging and production query/listener/control-plane topology parity,
- DigitalOcean connection and backend budget proof,
- durable wake-store capacity proof,
- active/standby relay lease and source cursor implementation,
- SLO/load proof and rollout kill switches.

## Privacy And Fan-Out Precision

Event-store wake notifications intentionally omit stream ids, event ids, tenant ids, account ids, user ids, session ids, guest emails, payment data, provider payloads, and event payloads. The fan-out core records only safe operational metadata such as source context, stream category, positions, event types, versions, rollout phase, and correlation id.

When a wake lacks high-cardinality routing identifiers, the relay must prefer safe over-wake to under-wake. Narrower fan-out that requires additional identifiers must go through the notification payload privacy review before production use.

## Observability

The fan-out core reports:

- invalid notification rejection,
- disabled source-context skips,
- no-interest skips,
- stale interest-index failures,
- enqueue failures,
- successful durable fan-out counts.

Later listener and scheduler slices should attach these observer events to the shared work-signal metrics so dashboards can separate notify receipt, relay catch-up, fan-out, control-plane enqueue, worker claim, projection execution, and checkpoint readiness latency.
