# Platform Work-Signal Composite

The platform work-signal composite is the internal runtime surface for Postgres wake notifications: one envelope
contract, one emitter, one listener/waiter implementation, and one disposition inventory for every wake family (#1248,
#1238). It exists so projection wakes, checkpoint readiness, durable job events, projection operation events, realtime
SSE wakes, and future scheduled/manual or reconciliation triggers share emission, waiting, fallback, redaction, and
metrics behavior instead of growing parallel `pg_notify`/`LISTEN` patterns.

Governing decision: [ADR 0010: Push-Driven Projection Runtime](../adr/0010-push-driven-projection-runtime.md).
Connection accounting: [Push-Wake Connection Budget](./push-wake-connection-budget.md).
Operator view: the `/wake-status` endpoint returns this document's disposition inventory as `origins`
(see [Push-Wake Operations](../runbooks/push-wake-operations.md)).

## Owning Surface

`infrastructure/platform-runtime/work-signal-composite.ts` owns:

- **Envelope contract**: `createWorkSignalEnvelope` / `serializeWorkSignalEnvelope` / `parseWorkSignalEnvelope` with
  `schemaVersion`, `payloadVersion`, a closed `kind` set, `source`, `emittedAt`, optional `correlationId`, and a JSON
  object payload.
- **Payload safety**: a sensitive-key denylist aligned with the event-store and relay wake denylists (#1235) — wake
  hints carry opaque work identifiers, sequences, and correlation metadata, never payload bodies — plus a serialized
  size limit (4 KiB default). Reviewed value-level exception: `realtime.outbox-wake` topic values can embed account
  identifiers (for example `account:{accountId}:listings`) because topics are the realtime routing key; this matches
  the legacy raw payload exactly, the denylist is key-based by design, and topic values never include emails, payment
  identifiers, or session tokens (enforced by the realtime topic policy).
- **Emission**: `emitPostgresWorkSignalNotification` validates the channel name, serializes the envelope, executes
  `SELECT pg_notify(...)` on the caller's queryable (so emission joins the caller's transaction), and reports observer
  metrics.
- **Waiting**: `createPostgresWorkSignalWaiter` holds one lazily connected listener per channel per pool, fans a
  notification out to per-wait `matches` predicates, bounds every wait with a timeout, falls back to that timeout when
  `LISTEN` is unavailable (PgBouncer transaction pools), circuit-breaks reconnect attempts via
  `listenRetryCooldownMs`, and recovers automatically after transient connection failures.
- **Observer hooks**: emitted/received/wait-ended/listener-unavailable/payload-rejected events with structural fields
  for logs and metrics. The received event includes the parsed notification so adapters can derive structural metadata
  (for example realtime topics); observers must never log raw payloads.
- **Disposition inventory**: `listWorkSignalOriginDispositions()` — the tracked migration/reuse disposition for every
  wake origin family, exposed on the operator wake-status endpoint.

`pg_notify` remains a wake signal only. Every family keeps its own durable source-of-truth rows; a missed or duplicate
notification costs latency, never correctness, because all consumers retain bounded polling or durable replay.

## Channels And Adapters

| Origin family | Kind | Channel | Adapter |
| --- | --- | --- | --- |
| Event-store commits | `event-store.commit` | `platform_event_store_commits` (per enabled source-context database) | Direct emission in `event-core-postgres/event-store.ts` with composite-compatible envelopes (approved exception: importing the composite would create a package cycle). Consumed only by the worker-owned projection wake relay. |
| Projection wake intents | `projection.wake-intent` | none — durable control-plane rows (`platform_projection_wake_intents`) | Relay fan-out writes durable wake intents; the worker scheduler claims them on bounded intervals. |
| Checkpoint readiness | `projection.checkpoint-ready` | none — durable control-plane rows (`platform_projection_checkpoint_readiness`) | Worker records readiness; API read-consistency waiters poll with bounded timeouts. |
| Projection operation events | `projection-operation.event` | `platform_projection_operation_events` (control database) | `control-plane.ts` emits through the composite; API SSE waiters use the composite waiter with legacy-payload compatibility. |
| Durable job events | `durable-job.event` | `durable_job_events` default; context-named channels (for example `catalog_source_observation_durable_job_events`) share the contract | `durable-job-store.ts` / `durable-job-work-units.ts` emit through the composite in the same transaction as the event append; `waitForEvents` uses the composite waiter with legacy-payload compatibility and a 60 s reconnect cooldown. |
| Realtime SSE wakes | `realtime.outbox-wake` | `realtime_projection_patch` (realtime context databases) | `realtime-outbox-store.ts` emits through the composite after the outbox write; `createRealtimeOutboxWakeSignal` wraps the composite waiter with topic matching (envelope first, legacy payload fallback) behind the unchanged `RealtimeWakeSignal` route contract. |
| Scheduled/manual triggers | `scheduled-runner.due` | reserved | No emitters yet; scheduled runners poll on their intervals. Adapter lands with the #1249 scheduled/manual phase. |
| Reconciliation | `reconciliation.requested` | reserved | No emitters yet. |
| Transactional email outbox | — | none | Scheduled/outbox exception: claim/retry polling dispatcher over provider-owned rows; interval dispatch is already bounded by provider rate limits, so wake signals add no latency value. |
| Notification outbox | — | none | Same scheduled/outbox exception posture. |

## Rolling-Deploy Compatibility

Migrated waiters accept both the composite envelope and the family's legacy raw payload (`{ jobId, sequence }` for
durable jobs, `{ context, projection, topics }` for realtime, `{ operationId, sequence }` for projection operations), so
old emitters keep waking new waiters during a deploy overlap. Old waiters that cannot parse a new envelope simply wait
out their bounded poll timeout — the documented latency-hint contract. Legacy payload parsing exists only inside the
adapters; new code must not parse notification payloads outside the composite.

## Fallback, Kill Switches, And Budget

- Every wait is bounded: timeout fallback when no notification arrives, when `LISTEN` is unavailable (staging PgBouncer
  transaction pools make it best-effort), or during the reconnect cooldown after a listener failure.
- `config.realtime.wakeSignalEnabled` remains the realtime wake-signal kill switch; durable-job and
  projection-operation waits degrade to pure polling automatically and need no switch. Relay/event-store emission keep
  their existing switches (`WORKER_PROJECTION_WAKE_RELAY_ENABLED`, `PLATFORM_EVENT_STORE_WAKE_NOTIFICATIONS_ENABLED`).
- Listener connections are unchanged by the composite migration: one pooled checkout per channel per pool, counted
  inside `api_total_pool_demand` in the [connection budget](./push-wake-connection-budget.md). Only the fenced relay
  holds direct source-database listeners.

## Guardrail

`scripts/check-structure/work-signal-primitives.test.mjs` blocks new direct `pg_notify`/`LISTEN`/legacy wake-helper
usage outside an approved, owned exception list (currently: the composite itself, the event-store emission exception,
and the projection wake relay). New wake features must use the composite entrypoints or record a reviewed exception
there and in this document's inventory.

## Remaining Work

- Scheduled/manual trigger and reconciliation adapters (phase-mapped in #1249).
- Combined load proof for projection + durable job + projection operation + realtime wake traffic (#1237).
- Moving the event-store emission exception onto shared envelope helpers without creating a package cycle.
- Runtime config validation that fails when a stale listener path is required without an approved exception (belongs
  with the #1249 rollout-flag phase).
