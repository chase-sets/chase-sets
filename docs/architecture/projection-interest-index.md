# Projection Interest Index

## Purpose

The projection interest index (#1220) is the in-memory mapping the push-first runtime uses to answer one question fast: given a source-context wake, which projection checkpoints need durable wake intents? It is built from the same projection-group declarations the worker already hosts, keyed by source context, event type, stream prefix, projection group, checkpoint, priority lane, and route dependency, and versioned by a stable content hash.

The contract lives in `@chase-sets/platform-runtime/projection-interest-index`. Consumers:

- **Active relay (#1242):** `fanOutEventStoreWakeNotification` maps every accepted source wake through `createProjectionWakeIntentInputs` and enqueues the resulting intents in the durable control-plane wake store. Each intent records the index version in its metadata, and relay cursors persist the version they fanned out under.
- **API wake-before-wait (#1239):** API processes resolve exact route dependencies through the same `resolveReadConsistencyDependency` declarations the index is built from, then enqueue `api-wait` intents through pooled queries — no source database listeners. `createRouteProjectionWakeIntentInputs`/`lookupRouteProjectionInterests` expose the identical route-dependency mapping for index-side consumers.
- **Worker wake scheduler:** disabled entries are excluded from relay fan-out, and `WORKER_WAKE_DISABLED_PROJECTIONS` removes the projection from the worker's hosted wake groups.

## Inputs: Declarations Plus Migration Overrides

`buildProjectionInterestIndex` combines:

1. **Projection-group subscription runners** — source contexts, event types, stream prefixes, checkpoint keys, bootstrap requirements.
2. **Resolved API mounts (optional)** — read-freshness route declarations, compiled to route-dependency entries.
3. **Overrides** — owner, priority lane, disabled state, and opt-out reasons per projection (optionally per source context).

The platform worker feeds overrides from two sources, in priority order (first match per scope wins):

1. `WORKER_WAKE_DISABLED_PROJECTIONS` deployment-level disables (operator kill switch).
2. `listProjectionInterestOverridesForPushMigration()` from `@chase-sets/platform-runtime/projection-push-migration` — the real rollout/owner/opt-out data required by #1220: owners for every projection group (from the [source-context wake registry](./source-context-wake-registry.md)), disables for registry-`disabled`/`opted-out` source contexts with their recorded reasons, and owner-approved projection opt-outs from the [push-first migration inventory](./push-first-projection-migration.md).

## Lookup Behavior With Privacy-Safe, Coarse Payloads

Event-store wake notifications are deliberately coarse: they omit stream ids, event ids, and every other high-cardinality or sensitive identifier (see [Event-Store Wake Notifications](./event-store-wake-notifications.md)). The index is designed so coarseness can only widen fan-out, never narrow it:

- **No event types in the payload** → the lookup returns every enabled entry for the source context.
- **Event types present** → the lookup unions wildcard entries (entries that declare no event-type filter) with exact event-type matches. An entry with declared event types and a lookup without any still matches.
- **No stream ids in the payload** → stream-prefix filters are skipped entirely; an entry with declared stream prefixes matches any lookup that provides no stream ids.
- **Stream ids present** (worker/API-originated lookups only) → prefix matching narrows the result.

The invariant: **a missing identifier can never cause an under-wake.** When exact routing would require identifiers the payload must not carry, the platform takes safe over-wake plus metrics instead of payload expansion. Spurious wakes are bounded structurally — the durable wake store coalesces intents per (source, target, projection, checkpoint, lane), and a woken projection that finds no new source rows is a cheap no-op.

No-interest lookups are not silent: the relay records a `skipped/no-interests` fan-out (`chase_sets_projection_wake_relay_fan_out_total{status="skipped", reason="no-interests"}`) and logs `projection-wake-relay.fan_out.no_interests`.

## Stale Index Handling (Explicit Policy)

The index snapshot is immutable and content-versioned. Staleness is an explicit state, never a silent drop:

- Lookups against a `stale` index throw `ProjectionInterestIndexStaleError` unless the caller passes `allowStale: true` (the bounded last-known-good escape hatch; the snapshot carries `generatedAt` and `staleReason` for age telemetry).
- The relay treats a stale index as a **failure, not a skip**: fan-out fails with reason `stale-interest-index`, the metric/alert path counts it, and — critically — the relay cursor does not advance past the wake. Durable catch-up re-delivers the same source positions after the index reloads, so wakes are deferred, never lost. Polling and exact read-after-write waits keep freshness bounded meanwhile.
- `createProjectionInterestIndexCache` provides `reload`/`markStale` semantics for runtimes that need explicit reload coordination during rolling deploys.

In the current deployment the worker builds the index once at startup from its hosted projection declarations, so "reload" is a worker restart/deploy; index versions are content-hashed, so mixed-version workers during a rolling deploy disagree only when declarations actually changed, and each records its own version on the intents it enqueues.

## Operator Surfaces

| Surface | What it shows |
| --- | --- |
| Worker `GET /internal/workers/status` → `projectionWakeRelay.interestIndex` | Full index summary: version, schema/payload versions, `generatedAt`, status + stale reason, entry/enabled/disabled counts, route-dependency count, enabled source contexts, per-source and per-lane enabled entry counts |
| Worker status → `projectionWakeRelay.interestIndexVersion` | Loaded version (kept for runbook compatibility) |
| Admin Push wakes tab / `GET .../projections/wake-status` | Index version per relay cursor; rollout state per source context; push-first migration status (owner, status, opt-out) per projection group |
| `projection-wake-pipeline` dashboard | `chase_sets_projection_wake_relay_fan_out_total` by `status`/`reason` — no-interest skip counts, stale-index failures, fan-out successes; intents per lane |

## Honest Gaps

Tracked in [Push-Wake SLO And Load Proof](./push-wake-slo-load-proof.md):

- No lookup-latency histogram (accepted: in-memory map lookups).
- Safe over-wake rate is structurally bounded but not measured live.
- The worker builds its index without resolved API mounts, so worker-side route-dependency coverage reports zero; route-dependency truth for operators is the registry-derived migration inventory, and API-side waits resolve dependencies from the same declarations directly.
