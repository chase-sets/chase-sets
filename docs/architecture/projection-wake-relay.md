# Projection Wake Relay

## Purpose

The projection wake relay is the worker-owned bridge between source event-store wake hints and durable projection work. It keeps `pg_notify` cheap and non-durable while ensuring accepted projection work is represented in the control-plane work-signal store before ordinary workers or API waiters depend on it.

This document describes the relay fan-out core and disabled-by-default active relay runtime shipped for Milestone #19. Deployable listener URL wiring, DigitalOcean connection-budget validation, and production source-context enablement remain gated by the topology and budget issues.

## Fan-Out Core

The `@chase-sets/platform-runtime/projection-wake-relay` module owns the pure fan-out path:

1. Parse and validate the event-store wake notification envelope.
2. Check the source context against the source-context wake relay config.
3. Map the wake through the projection interest index.
4. Create source-scoped projection wake intent inputs.
5. Enqueue/coalesce those intents through the durable work-signal store.

The function is intentionally callable by a future active listener, reconciliation scanner, or proof-mode harness without duplicating fan-out logic.

## Active Runtime Primitive

The same module also exposes `runProjectionWakeRelayActiveSession`, a worker-owned runtime primitive that can run the relay behind a fenced control-plane lease.

The active session:

1. Resolves enabled source contexts from the source-context wake relay config.
2. Acquires the `projection-wake-relay:active` control-plane lease.
3. Opens dedicated listener connections for configured source contexts when a listener pool is provided.
4. Runs startup catch-up from durable source event-store rows after each source's persisted relay cursor.
5. Treats live notifications as hints that enqueue another durable catch-up pass.
6. Reconnects listener connections after errors and catches up again after reconnect.
7. Advances `platform_projection_wake_relay_cursors` only after `fanOutEventStoreWakeNotification` succeeds for the source position.

The runtime accepts source event-store adapters for reads and optional listener pools for direct/session-compatible `LISTEN` connections. This preserves the intended topology: the relay owns listener connections, while source event-store reads use normal query paths.

## Boundaries

Durable truth remains outside the notification:

- Source event-store rows remain the durable source of committed facts.
- Projection checkpoints remain the durable source of projection readiness.
- The control-plane wake store owns accepted wake intents, coalescing, claim state, retry, and cleanup.
- The control-plane relay cursor table owns the last source position successfully fanned out by a fenced relay owner.

The fan-out core does not claim that a source position has been fully caught up. It only converts a valid wake hint into durable work for interested projections. The active runtime owns catch-up and advances the relay cursor only after durable source rows have been read and fan-out has succeeded.

The cursor advancement query verifies the supplied lease name, owner id, fencing token, and expiry against `platform_control_leases`. A stale relay process cannot advance the cursor after losing the active lease.

## Rollout Gate

Default runtime behavior is disabled. `listSourceContextWakeRelayConfigs()` returns only source contexts whose registry entry has relay fan-out enabled. The same registry entry also controls write-side event-store wake emission, so a source context should not produce unexplained notifications or listen-only fan-out.

Production enablement still requires:

- staging and production query/listener/control-plane topology parity,
- DigitalOcean connection and backend budget proof,
- durable wake-store capacity proof,
- deployable listener URL wiring and runtime enablement,
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

The active runtime reports lease acquisition/miss/loss, listener connection/unavailability/disconnection, notification receipt, catch-up start/completion/failure, cursor advancement, and all fan-out core events.

Later deployable and scheduler slices should attach these observer events to the shared work-signal metrics so dashboards can separate notify receipt, relay catch-up, fan-out, control-plane enqueue, worker claim, projection execution, and checkpoint readiness latency.
