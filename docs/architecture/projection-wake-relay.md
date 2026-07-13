# Projection Wake Relay

## Purpose

The projection wake relay is the worker-owned bridge between source event-store wake hints and durable projection work. It keeps `pg_notify` cheap and non-durable while ensuring accepted projection work is represented in the control-plane work-signal store before ordinary workers or API waiters depend on it.

This document describes the relay fan-out core and the active relay runtime shipped for Milestone #19. The deployable listener URL wiring (`WORKER_LISTENER_DATABASE_URL_<CONTEXT>` via Terraform), the plan-time DigitalOcean connection-budget checks, and staging enablement for the wave-1 source contexts are live. The production gates from #1243/#1237 (topology parity, least-privilege listener credentials, connection budget, SLO ratification) are delivered; flipping production source-context enablement remains a deliberate operator decision through the [rollout-controls runbook](../runbooks/push-wake-rollout-controls.md) with the parity-inspection and SLO evidence recorded per the registry's production evidence gates.

## Fan-Out Core

The `@chase-sets/platform-runtime/projection-wake-relay` module owns the pure fan-out path:

1. Parse and validate the event-store wake notification envelope.
2. Check the source context against the source-context wake relay config.
3. Map the wake through the [projection interest index](./projection-interest-index.md).
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

## Rolling-Deploy Envelope Compatibility

Event-store wake notifications use a strict `schemaVersion` and an additive `payloadVersion`. The relay rejects unknown schema versions because they may redefine the envelope contract, but accepts positive payload versions when the required v1 fields remain valid. Additive payload fields are ignored by the current fan-out mapper and are not copied into durable wake metadata; the relay records only the observed payload version and the safe structural v1 fields.

Live `LISTEN` notifications remain latency hints. The active relay does not trust the notification body to advance work; a received notification only schedules durable catch-up from source event-store rows after the persisted relay cursor. During a rolling deploy, an older or newer emitter can therefore wake a relay instance without making correctness depend on that specific payload shape. If a breaking schema ever appears, the documented fallback is bounded catch-up/polling latency, not lost projection work.

## Deployable Hosting

The platform worker hosts the relay as a long-lived supervised session beside its runner loops:

1. Every implemented bounded context's runtime services pass a registry-derived `wakeNotifications` config to its Postgres event store, so write-side emission is wired everywhere and controlled exclusively by the source-context wake registry. Emission is after-commit, best-effort, and never fails the append.
2. `startProjectionWakeRelaySupervisor` runs `runProjectionWakeRelayActiveSession` in a retry loop: `no-enabled-sources` idles on a long retry, `lease-missed` retries on the standby interval (another worker holds the fenced `projection-wake-relay:active` lease, giving active/standby failover across worker instances), `lease-lost` retries as standby, and session crashes use exponential backoff.
3. Source runtimes use pooled query connections for durable catch-up reads and a dedicated listener pool (one connection) per source context, created only when the worker hosts that context's database pool, `WORKER_LISTENER_DATABASE_URL_<CONTEXT>` is configured, and the registry enables that source. A source without a listener URL runs catch-up-only and logs that state.
4. Worker drain aborts the supervisor before stopping runner loops; listener pools close on shutdown. The worker status endpoint reports the supervisor state, configured sources, listener sources, and the loaded interest-index version.

`WORKER_PROJECTION_WAKE_RELAY_ENABLED=false` is the deployable-level kill switch; the registry remains the per-source rollout control.

## Listener URL Topology

`LISTEN` requires direct or session-compatible connections. Managed PgBouncer transaction pools cannot carry `LISTEN`, so Terraform provides the active relay with per-context direct cluster URLs for the wave-1 source contexts (`checkout`, `marketplace`, `ordering`, `payments`). Staging and production build those URLs from the same Terraform expression using dedicated least-privilege `cs_<env>_<context>_wake_listener` database users (#1243). Preview environments intentionally omit listener URLs because push rollout never targets previews. Only the active DOKS relay holds listener connections; ordinary query traffic stays pooled. The per-environment connection ledger and plan-time Terraform checks are documented in the [push-wake connection budget](./push-wake-connection-budget.md).

## Rollout Gate

`listSourceContextWakeRelayConfigs()` returns only source contexts whose registry entry has relay fan-out enabled - currently the staging-enabled wave-1 hot path (`checkout`, `marketplace`, `ordering`, `payments`). The same registry entry also controls write-side event-store wake emission, so a source context should not produce unexplained notifications or listen-only fan-out; environments outside the staging ramp stay inert through the relay and emission kill switches described in the [source-context wake registry](./source-context-wake-registry.md).

Production enablement still requires:

- staging and production query/listener/control-plane topology parity,
- DigitalOcean connection and backend budget proof,
- durable wake-store capacity proof,
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

The worker-side claim, execution, completion, and readiness path is documented in the [projection wake-intent scheduler](./projection-wake-scheduler.md). The platform worker attaches both relay and scheduler observer events to the shared wake metrics (`recordProjectionWakeRelayCatchUp`, `recordProjectionWakeRelayFanOut`, `recordProjectionWakeIntentOutcome`), so the `projection-wake-pipeline` dashboard and `platform-worker-wake-alerts` rules separate notify receipt, relay catch-up, fan-out, control-plane enqueue, worker claim, projection execution, and checkpoint readiness latency.

## Credentials And Least Privilege

Current credential posture for each relay-adjacent connection, as validated in `infrastructure/digitalocean/platform/locals.tf` and the deployable configs:

- **Listener connections (staging and production):** Terraform builds `WORKER_LISTENER_DATABASE_URL_<CONTEXT>` from a dedicated per-context wake-listener database user (`digitalocean_database_user.wake_listeners[...]`, named `cs_<env>_<context>_wake_listener`) against the cluster's direct port, because `LISTEN` cannot ride the PgBouncer transaction pools. The credential is least-privilege (#1243): `CONNECT` on the context database plus `USAGE` on the schema and a **best-effort** `SELECT` on the event-store tables (`event_store_events`, `event_store_streams`) as defense-in-depth. No DML and no access to domain tables. Grants are applied by `terraform_data.wake_listener_database_grants` in the same apply that creates the users. The plan-time check `wake_listener_least_privilege` fails any configuration whose listener URLs regress to the owning context users.
- **Catch-up reads:** durable event-store catch-up reads use the worker's normal pooled context query URLs, scoped the same as all other worker projection reads. The listener connection itself only ever issues `LISTEN`/`UNLISTEN`; its best-effort read-only event-store grant exists so the credential stays honest if catch-up ever rides it (convergence procedure: taint the grants resource and re-apply).
- **Control plane:** wake intents, readiness rows, waiters, relay cursors, and leases live in the control database and are written through `PLATFORM_CONTROL_DATABASE_URL`, which holds no bounded-context domain tables. Relay cursor persistence never uses the listener connection.
- **Operator/debug surface:** the only wake-store debug surface is the DOKS platform worker's `GET /internal/workers/status`, with no public ingress; it returns aggregate intent counts, control flags, relay supervisor state, and lease/runner metadata only — never intent metadata, payloads, or error bodies.

The previous deferral (context owning-user listener credentials, tracked by #1243) is resolved: dedicated wake-listener roles are provisioned in both staging Terraform user provisioning and production, which no longer uses the binding strategy for listeners.

## Telemetry Privacy, Retention, And Incident Response

- **Redaction at write time:** wake notification envelopes are denylist-checked and size-capped before `pg_notify` (event store), relay-enriched metadata is denylist-checked before enqueue (`assertSafeRelayMetadata`), and the durable work-signal store rejects sensitive metadata keys and redacts sensitive failure-detail keys for every origin (`work-signal-store.ts`). Composite envelopes apply the same checks (`work-signal-composite.ts`).
- **Redaction at log time:** all wake observer events flow through the shared structured logger, which recursively redacts sensitive field names and reduces error objects to name + message (`sanitizeLogFields` in `@chase-sets/observability`).
- **Metrics:** wake metrics carry only bounded structural labels (source/target context, projection, lane, origin, outcome, status, reason) via `boundedMetricLabel`; no identifiers from request traffic enter metric labels.
- **Retention:** wake intents, readiness rows, and waiter rows expire on bounded TTLs and are reaped by the `work-signals.cleanup` runner (see [projection wake-intent scheduler](./projection-wake-scheduler.md)); telemetry retention follows the platform observability stack's standard log/metric retention.
- **Incident response:** if sensitive data is ever found in a wake surface, kill emission and relay with the switches in the [push-wake rollout controls runbook](../runbooks/push-wake-rollout-controls.md) (wakes are acceleration only; durable correctness is unaffected), purge affected wake-store rows via the bounded cleanup path or direct deletion in the control database, and treat the writer as the defect — the store-level denylist failure means a new writer bypassed review.
