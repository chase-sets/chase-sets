# Stream-Isolated Projection Errors

## Intent

Make projection draining resilient to poisoned events without hiding data problems or coupling publishers to projector consumers.

Projectors should keep draining unrelated work while preserving per-stream ordering for the stream or aggregate that failed. A poison event in `catalog.item-a` should not stop `catalog.item-b`, Catalog Source Observation projections, downstream subscriptions, jobs, or other worker runners. Later events for the same affected stream must not be applied until the failed event is resolved or the projection is rebuilt.

This extends the consumer-owned projection model from `20260524-consumer-owned-projections.md`: publishers append durable events and finish command/job work; consumers own catch-up, error isolation, retry, health, and repair.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260524-stream-isolated-projection-errors`
- Branch: `codex/stream-isolated-projection-errors`
- Base: `origin/main` at `955b3698` (`Make catalog projections consumer-owned`)
- Sandbox id: `9a33ba31`
- Dependency setup status: complete via `pnpm run deps:install`
- Sandbox doctor: passed
- Product/runtime edits in this planning pass: none

## Owning Contexts

- `@chase-sets/event-core` owns the generic projector contract, failure classification types, run result shape, and ordering policy vocabulary.
- `@chase-sets/event-core-postgres` owns durable checkpoint, blocked stream, poison event, and lease-safe mutation storage for local context projectors.
- `@chase-sets/bounded-context-runtime` owns cross-context subscription replay, projection group status, source-context checkpoints, and stream-isolated replay for projection groups.
- `@chase-sets/platform-runtime` owns worker runner status, scheduling, lease/fencing, and operational surfacing of degraded runners.
- Bounded contexts own projection handlers, read-model schemas, projection group declarations, event applicability constraints, and context-specific repair surfaces.
- Catalog is the first high-volume proof because Source Observation promotion and Catalog Item projections exposed the production symptom.
- Deployables remain thin composition roots. They must not know which projectors exist, which events they handle, or how poison events are repaired.

## Repo Evidence

- `bounded-contexts/README.md` says bounded contexts own read models and tests, while cross-context interaction uses stable IDs and published integration events.
- `docs/architecture/bounded-context-structure.md` reserves shared infrastructure for generic adapters and keeps projection behavior in bounded contexts plus shared runtime.
- `bounded-contexts/catalog/context.json` has `drainProjectorsOnWrite: false` and lists worker deployables, so Catalog projections already rely on consumer workers.
- `.codex/plans/20260524-consumer-owned-projections.md` resolved that command handlers, imports, background jobs, and admin bulk actions must not drain their own projectors.
- `contracts/event-core/projector.ts` currently loads one global checkpoint, reads a global batch, invokes the event-type handler if present, and saves the checkpoint after each event. Any handler exception aborts the run before the checkpoint advances.
- `infrastructure/bounded-context-runtime/index.ts` uses the same global-checkpoint behavior for cross-context subscriptions. It already filters by `eventTypes` and `streamPrefixes`, but a matched handler failure stops the whole subscription runner.
- `infrastructure/event-core-postgres/projection-store.ts` stores only `projector_name` and monotonic `last_global_position`; it has no durable poison-event or blocked-stream state.
- `infrastructure/platform-runtime/worker.ts` now gives each runner one bounded turn, but if `runOnce()` throws it records the whole runner as `error`.
- `docs/architecture/projection-rebuild-replay.md` already defines projection revisions, automatic group rebuilds, and the rule that workers must run projection groups through the revision-aware path.
- `contracts/event-core/storage.ts` and `infrastructure/event-core-postgres/event-store.ts` preserve `streamId`, `streamVersion`, and `globalPosition`, and support `readStream`, so repair can replay one stream in stream order.

## Resolved Decisions

- Use projection-consumer isolation, not publisher awareness. Publishers do not call projectors, do not classify projection failures, and do not emit projection repair commands.
- The default scalable policy should be stream-isolated strict ordering: a poison event blocks that projection for that event's `streamId`, advances the projection's global scan past the event, and lets other streams continue.
- Preserve same-stream ordering. Once a stream is blocked for a projection, later events from that stream are not applied to that projection until the blocked event is resolved and same-stream replay catches up in stream-version order.
- Irrelevant events never poison a projection. Events outside a subscription's `eventTypes` or `streamPrefixes`, or events with no handler in a local projector, should advance the global checkpoint as today.
- Handler-matched events are relevant. If a handler exists and throws, runtime treats the failure as relevant unless the handler throws an explicit transient infrastructure error.
- Do not silently skip poison events. Poison state must be durable, visible in health, and recoverable through retry, explicit ignore where safe, or projection rebuild.
- Distinguish transient failures from deterministic poison. Database outage, lost lease, connection reset, or other infrastructure failure should stop the turn without advancing the checkpoint. Handler/data failures should create poison state and keep unrelated streams draining.
- Keep global-strict available. Some projections may depend on total global order or cross-stream aggregates; they must declare a policy that halts the whole projection on handler failure.
- Projection groups and local projectors need the same semantics. Cross-context subscriptions are projector consumers with source filters and target read models.
- Repair must be idempotent. Retry and rebuild paths assume handlers can replay safely, or side effects go through durable outbox/idempotency keys.

## Target Runtime Model

Add a projection error policy to local projectors and bounded-context subscriptions:

- `strict-per-stream`: default for stream-addressable projections. Poison blocks only `projection + streamId`.
- `global-strict`: stop the whole runner on relevant handler failure. Use for projections where later unrelated streams cannot be valid without total-order processing.
- `tolerant-ignore`: opt-in only for events whose handler explicitly declares that the failed transformation is non-critical and safely skippable. This should be rare and audited.

Add durable state beside each projection checkpoint:

- `projection_poison_events`
  - `projection_key`: local projector name or subscription checkpoint key
  - `projection_name`
  - `projection_kind`: `projector` or `subscription`
  - `target_context_name`
  - `source_context_name` nullable for local projectors
  - `projection_revision` or `subscription_version`
  - `stream_id`
  - `stream_version`
  - `event_id`
  - `event_type`
  - `global_position`
  - `failure_kind`: `poison` or `transient`
  - `error_message`
  - `error_stack` nullable
  - `state`: `blocked`, `retrying`, `resolved`, `ignored`
  - `retry_count`
  - `first_seen_at`, `last_seen_at`, `resolved_at`
  - unique active key on `projection_key + event_id`

- `projection_blocked_streams`
  - `projection_key`
  - `stream_id`
  - `first_blocked_global_position`
  - `first_blocked_stream_version`
  - `last_seen_global_position`
  - `deferred_event_count`
  - `state`: `blocked`, `retrying`, `resolved`
  - `updated_at`
  - primary key on `projection_key + stream_id`

The store API should expose this without leaking SQL details into projector logic:

- `loadCheckpoint(projectionKey)`
- `saveCheckpoint(projectionKey, globalPosition)`
- `isStreamBlocked(projectionKey, streamId)`
- `recordPoisonEvent(input)`
- `recordDeferredBlockedStreamEvent(input)`
- `listBlockedStreams(filter)`
- `resolvePoisonEvent(input)`
- `resolveBlockedStream(input)`

For cross-context subscriptions, the existing `event_subscription_checkpoints.checkpoint_key` should be the projection key. For local projectors, `projectorName` should remain the key.

## Drain Algorithm

For each global batch event after the projection checkpoint:

1. Convert to transport event and decide applicability using subscription `eventTypes`, `streamPrefixes`, and handler lookup.
2. If not applicable, advance the global checkpoint and continue.
3. If the stream is already blocked for this projection:
   - Do not invoke the handler.
   - Record/update deferred stream state with the event's stream version and global position.
   - Advance the global checkpoint and continue.
4. If applicable and unblocked, run the handler.
5. On success, advance the global checkpoint.
6. On transient infrastructure failure:
   - Do not advance the checkpoint.
   - Mark the runner `error` for this turn.
   - Let worker retry with normal lease/backoff behavior.
7. On deterministic handler/data failure under `strict-per-stream`:
   - Record a poison event.
   - Mark the stream blocked for this projection.
   - Advance the global checkpoint.
   - Continue draining unrelated streams in the same or next worker turn.
8. On deterministic handler/data failure under `global-strict`:
   - Record failure metadata if possible.
   - Do not advance the checkpoint.
   - Mark the runner `error`.

When a blocked stream is retried:

1. Acquire a projection repair lease scoped to `projection_key + stream_id`.
2. Load the first blocked stream version and read the stream through `eventStore.readStream`.
3. Apply only events relevant to that projection, in stream-version order, until the stream is caught up or another event fails.
4. Do not use global checkpoint movement during stream repair; the global scan already moved past these events.
5. Clear poison and blocked-stream state only after same-stream replay succeeds through the known deferred tail.
6. If repair fails again, increment retry metadata and keep the stream blocked.

## Health And Observability

Add a `degraded` state for projection consumers that are draining but have blocked streams. `error` should mean the runner cannot make progress this turn because of infrastructure, lost lease, global-strict poison, or unexpected runtime failure.

Runner and projection group status should include:

- blocked stream count
- active poison event count
- oldest blocked global position
- oldest blocked age
- last poison event type
- last poison stream id for operator diagnosis
- processed event count for the last turn
- source head/global lag where already available

Metrics must keep labels bounded as required by `docs/runbooks/observability.md`: use service, environment, context, projection name, projection kind, state, and event type. Do not label metrics by stream id, account id, item id, observation id, or event id.

Logs may include stream id and event id for repair diagnostics, but should be structured and rate-limited if repeated failures occur.

## Repair And Operations

Add an operator runbook and command/API path for projection poison repair:

- list degraded projections and blocked streams
- inspect poison event metadata and handler error
- retry one blocked stream
- retry all blocked streams for one projection with bounded concurrency
- mark a poison event ignored only when the projection owner documents why the event is irrelevant or safely lossy
- rebuild a projection group through the existing revision-aware rebuild path when handler/data changes make replay the safest recovery

Recommended first operator surface:

- CLI/script for immediate operations, because it is safer and faster than adding UI before the semantics settle.
- Admin UI read-only status after the CLI path is proven, showing degraded projections and blocked stream counts without exposing high-cardinality IDs in broad lists.

## Catalog Rollout

Catalog should be the first bounded context enabled for `strict-per-stream` because the observed issue came from high-volume Source Observation promotion and Catalog Item projection lag.

Catalog-specific steps:

- Audit Catalog projectors for stream-addressable assumptions:
  - `catalog.source-observation-*`
  - `catalog.item-*`
  - `catalog.reference-*`
  - integration/provider streams
- Make each Catalog projector declare `strict-per-stream` unless it truly needs `global-strict`.
- Ensure handlers are idempotent under replay and use upserts/deletes that tolerate duplicate handling.
- Ensure events that share an event type but are not meaningful to a handler return cleanly instead of throwing.
- Add a Catalog acceptance test where one Catalog Item stream poisons, another Catalog Item stream continues projecting, and Source Observation/read-model counts continue to catch up.

Downstream contexts should then migrate projection groups context by context:

- Inventory, Pricing, Marketplace, Discovery, Checkout, Ordering, Fulfillment, Payments, Settlement, Reputation, Notifications, Auth, Commercial Terms, and Support should declare policy with their projection groups.
- Any cross-stream aggregate projection must choose `global-strict` until it is redesigned around commutative/idempotent updates or partitioned by stream.

## Backward Compatibility And Migration

- Existing checkpoints continue to work. A projection with no blocked stream rows behaves like today's checkpointed scanner.
- New poison/block tables are additive and can be included in existing schema bootstrap paths.
- Existing projections should initially default through a conservative compatibility adapter during implementation, then move to explicit policy declarations before merge.
- For already-lagging projections from the production issue, deployment of this change does not require checkpoint reset. Workers continue from current checkpoints. If a future poison event is found, only that stream is blocked while other streams drain.
- Events that were already skipped by a checkpoint because a prior implementation advanced incorrectly cannot be recovered by this feature alone; use projection rebuild replay for that projection group.
- If a projection is currently stopped on an error before this change and its checkpoint has not advanced past the failing event, after deployment `strict-per-stream` can classify the same event as poison, block that stream, advance the global scan, and continue unrelated streams.
- Projection definition changes that alter replay output still require `projectionRevision` bumps under `docs/architecture/projection-rebuild-replay.md`.

## Implementation Checklist

1. [x] Extend projector contracts in `contracts/event-core/projector.ts`.
   - Add projection error policy types.
   - Add poison/block store capability types without making every caller know Postgres.
   - Add run result fields for `degraded`, `blockedStreams`, and `poisonEvents`.
   - Add explicit transient projection error helper or classification hook.

2. [x] Add durable poison/block storage in `infrastructure/event-core-postgres`.
   - Add additive schema SQL.
   - Implement the store API.
   - Keep checkpoint writes monotonic.
   - Add tests for idempotent poison upsert, blocked-stream updates, resolution, and concurrent repair leases or fencing.

3. [x] Update local projector execution.
   - Implement `strict-per-stream`, `global-strict`, and no-op irrelevant event behavior.
   - Keep per-event checkpoint saves.
   - Ensure existing projectors can opt in with minimal config.
   - Add `contracts/event-core` tests with an in-memory event store and poison store.

4. [x] Update bounded-context subscription runners.
   - Add policy to `BcEventSubscription` and declarations if needed.
   - Apply the same blocked-stream algorithm in `createSubscriptionRunner`.
   - Use subscription `checkpointKey` as the projection key.
   - Include degraded/poison state in `ContextSubscriptionStatus` and `ContextProjectionGroupStatus`.

5. [x] Update worker status and control plane.
   - Add `degraded` to runner states.
   - Mark a runner degraded when it processed work or is caught up except for blocked streams.
   - Preserve `error` for transient/global failures.
   - Keep bounded runner fairness from PR #273.

6. [x] Add repair primitives and reset cleanup.
   - Add store methods for listing blocked streams, resolving one blocked stream, and clearing projection errors.
   - Clear poison/block state when subscription checkpoints reset for projection-group rebuild.
   - Route rebuild needs through the existing projection group rebuild path.
   - Follow-up: add an operator CLI/API for retrying one `projection_key + stream_id` and bounded bulk retries.

7. [x] Enable Catalog.
   - Declare policies for Catalog local projectors.
   - Add focused tests around Source Observation promotion and Catalog Item stream isolation.
   - Update Catalog admin/bulk workflow docs to explain degraded projection catch-up.

8. [x] Document architecture and operations.
   - Add `docs/architecture/stream-isolated-projection-errors.md`.
   - Add `docs/runbooks/projection-poison-events.md`.
   - Update `docs/README.md`.

## Verification Plan

Focused tests:

- `contracts/event-core`: irrelevant events checkpoint; handler success checkpoints; poison blocks one stream; later same-stream events are deferred; other streams continue; transient errors do not checkpoint.
- `infrastructure/event-core-postgres`: schema bootstrap; poison/block CRUD; monotonic checkpoint; retry resolution; concurrent repair does not double-apply.
- `infrastructure/bounded-context-runtime`: subscription filters still checkpoint irrelevant events; matched poison blocks one source stream; projection group reports degraded; global-strict subscriptions halt.
- `infrastructure/platform-runtime`: worker records `degraded`; worker continues scheduling other runners; `error` still records transient/global failures.
- Catalog runtime/read-model tests: one poisoned Catalog Item stream does not block another Catalog Item stream or Source Observation projection progress.

Repo checks:

- [x] `pnpm --filter @chase-sets/event-core test`
- [x] `pnpm --filter @chase-sets/event-core-postgres test`
- [x] `pnpm --filter @chase-sets/bounded-context-runtime test`
- [x] `pnpm --filter @chase-sets/platform-runtime test`
- [x] Focused Catalog tests for touched slices: `pnpm --filter @chase-sets/catalog test`
- [x] `pnpm run typecheck`
- [x] `pnpm run verify:static`

## Implementation Progress

- Added `strict-per-stream` and `global-strict` projection policies to shared contracts.
- Added durable Postgres poison-event and blocked-stream tables plus store methods.
- Updated local projectors to block only poisoned streams when stream isolation is enabled.
- Updated cross-context subscription runners to record poison state, defer later same-stream events, and continue unrelated source streams.
- Updated worker status to report `degraded` when a runner is making progress with blocked streams.
- Added architecture and runbook docs for poison-event semantics.
- Added focused tests for event-core, event-core-postgres, bounded-context-runtime, and platform-runtime.
- Added repair storage primitives and reset/rebuild cleanup for poison/block state.
- Deferred explicit repair CLI/API commands to a follow-up implementation step; current runtime records poison/block state, exposes store-level resolution primitives, and reports degraded health.
- Full Catalog tests, repo typecheck, and static verification pass after formatting.

Operational verification:

- Start sandbox workers with multiple projector runners.
- Seed or script events where stream A fails and stream B succeeds.
- Confirm stream B read model advances after stream A poison.
- Confirm status shows degraded, not globally error, for stream-isolated poison.
- Retry stream A after fixing the handler/test fixture and confirm blocked state clears.
- Rebuild a projection group and confirm poison/block rows for that projection key are cleared or superseded as part of reset.

## Risks And Pressure Tests

- Cross-stream projections can produce invalid results if stream isolation is applied blindly. Mitigation: require explicit `global-strict` for total-order projections and review all projection groups before enabling.
- Advancing a global checkpoint past a blocked stream means repair must replay from stream history. Mitigation: store `stream_id` and `stream_version`, and require event stores to retain stream history.
- Handlers with side effects can duplicate work on repair. Mitigation: side effects belong behind durable outbox/idempotency keys, or those projections remain global-strict until fixed.
- High-cardinality poison metrics can overload observability. Mitigation: keep metric labels bounded and put stream/event IDs in structured logs and operator detail views only.
- Rebuilds must not leave stale poison rows that confuse health. Mitigation: projection reset should clear poison/block state for the projection key or mark old rows superseded by revision.

## Open Questions

No blocking product/domain question for planning. The recommended implementation default is `strict-per-stream` for stream-addressable projections with explicit `global-strict` declarations for total-order projections.

Before implementation, each bounded context owner should classify its projection groups, but Catalog can proceed first as the proof point.

## Goal Completion Criteria For Implementation

- Durable poison/block storage exists and is covered by tests.
- Local projectors and cross-context subscriptions share the same stream-isolated semantics.
- Worker health distinguishes `degraded` from `error`.
- Catalog projections continue unrelated streams when one stream poisons.
- Operators can list and retry blocked streams without touching publishers.
- Architecture and runbook docs are merged.
- CI passes before PR merge.
- Staging and production deployments verify workers continue draining and degraded status is visible.
