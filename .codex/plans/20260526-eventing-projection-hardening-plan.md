# Eventing Projection Hardening

## Intent

Harden the eventing and projection system so projection rebuilds, replays, worker scheduling, ledger writes, lag reporting, and projection-handler transaction boundaries are safe under horizontal scale, large backlogs, operator-triggered rebuilds, and partial failures.

The implementation should preserve the event-driven standard already established: publishers write events and remain unaware of projection consumers; projection consumers own their processing, error handling, replay, and rebuild semantics.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-eventing-projection-hardening-plan`
- Branch: `codex/eventing-projection-hardening-plan`
- Base: freshly fetched `origin/main` at `188eeb7c`
- Sandbox id: `c6b06345`, port base `7050`
- Dependency setup status: `pnpm run deps:install` completed; `pnpm run sandbox:doctor` completed
- pnpm store path: default embedded worktree store `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- `infrastructure/bounded-context-runtime`: projection subscriptions, checkpoints, ledger, rebuild/reset APIs, projection status and lag contracts.
- `infrastructure/event-core-postgres`: event-store read/query shape and schema/index alignment.
- `infrastructure/platform-runtime`: projection operations API, worker leases, worker runner scheduling, runner status snapshots.
- `deployables/platform-worker` and `deployables/admin-support-worker`: environment/runtime capacity enforcement.
- `bounded-contexts/catalog`: Product Measure direct repair path and projection-owned read-model update semantics.
- Durable docs: system-level projection operations architecture and runbook belong under `docs/architecture/` and `docs/runbooks/`.

## Resolved Decisions

- Projection rebuild requests must become durable worker-owned operations, not synchronous API work.
- Rebuild/reset must be coordinated with projection runner leases before checkpoints, ledger rows, or read-model generations are changed.
- Rebuild correctness requires generation-aware or shadow-state cutover for projection-owned tables; no-op reset is insufficient for stale-row removal.
- Event-store filtering should align SQL predicates with indexes. Prefer normalized `stream_context_name` plus `stream_category` predicates for prefix groups, with production-like `EXPLAIN` validation.
- Ledger hot-path optimizations must preserve at-least-once processing, idempotency, poison isolation, and ACID completion of handler writes plus ledger state.
- Direct read-model repair helpers must either publish events or execute as one transaction.
- Worker capacity must fail fast or clamp when configured runner concurrency exceeds available DB pool capacity.
- Operator lag reporting must distinguish source scan lag from applicable-event lag.
- Projection handler APIs should make transaction-scoped execution explicit rather than relying only on optional context and `AsyncLocalStorage`.

## Open Questions

None blocking. The plan uses the safest default for a horizontally scalable event-driven system: queued operations, worker-owned execution, lease/fencing coordination, generation cutover, and explicit transaction contracts.

## Implementation Progress

- Durable projection operation queue is implemented in the platform control plane with claim TTL, fencing token, list/detail/cancel endpoints, admin enqueue routes, and a worker-owned projection operation runner.
- Rebuild and retry operations now acquire the same projection-group runner lease used by normal workers. Rebuild/reset paths accept `ProjectionRunContext` and check lease loss through reset, replay, retry, checkpoint deletion, and ledger application.
- Subscription checkpoint saves and application ledger claims now reject stale fencing tokens rather than allowing expired workers to overwrite useful state.
- Leased projection operations poll cancellation state, propagate abort signals, and apply transaction-local statement timeouts for projection DB work.
- Projection generation metadata is installed in bounded-context schemas and `generation-cutover` rebuilds have explicit start/complete/fail state hooks.
- Previous projection generations are retained after cutover and cleared only by a separate `projection-generation-retention` worker maintenance runner after the retention window expires.
- Projection group reset strategy is now an explicit bounded-context manifest contract. Existing groups declare either `replay-only` or `append-only-no-reset`; `truncate-owned-tables` is available only when explicitly declared; `generation-cutover` fails closed until a projection-specific adapter exists.
- Event-store `readAll` now adds normalized `stream_context_name` predicates when stream prefixes are present, and schema source includes the matching context/category/global-position index.
- Ledger compaction has been moved out of the hot drain path into the separate `projection-ledger-compaction` worker runner, with operational indexes added for status and retention scans.
- Admin projection operations are asynchronous from the API perspective and visible on the operations page alongside source lag and applicable lag estimates.
- Projection operation history now supports context, projection, state, and actor filters, plus operation summary metrics for queue depth, active operations, failures, oldest queued/running operation, and duration.
- Product-measure direct repair now runs delete/insert replacement in one transaction when a transaction-capable DB is available; event-first projection remains the standard path.
- Projection wrapper handlers now forward the transaction-scoped context and write durable realtime invalidation patches through `context.db`.
- New projection handlers can use `createTransactionalProjectorHandlerMap` to require a transaction-scoped projection database at runtime and in tests.
- Worker deployables emit structured runner/operation logs for lease misses, lease renew failures, operation start/completion/failure, runner completion/failure, owner ID, worker ID, fencing token, projection key/name, and stream ID when present.
- Worker deployables now fail fast when configured runner concurrency exceeds DB pool capacity unless explicitly overridden.
- Verification completed locally: `pnpm run verify:static`, `pnpm run verify:typecheck`, `pnpm run verify:test`, `pnpm run verify:build`, `pnpm run check:structure`, `pnpm run format:check`, `pnpm --filter @chase-sets/platform-runtime run test -- control-plane.test.ts worker.test.ts index.test.ts`, `pnpm --filter @chase-sets/bounded-context-runtime run test -- index.test.ts`, `pnpm --filter @chase-sets/event-core-postgres run test -- event-store.test.ts`, `pnpm --filter @chase-sets/event-core run test -- projector.test.ts`, and `pnpm --filter @chase-sets/catalog run test -- product-measures/api/runtime.test.ts realtime-invalidation.test.ts`.

## Implementation Checklist

### 1. Durable Projection Operation Queue

- [x] Add a projection operation table in the control plane, for example `platform_projection_operations`.
- [x] Model operation states: `queued`, `running`, `succeeded`, `failed`, `cancel_requested`, `cancelled`.
- [x] Store operation kind: `rebuild-projection-group`, `rebuild-context`, `retry-blocked-stream`, and future `replay-stream`.
- [x] Store target identity: `context_name`, `projection_name`, optional `projection_key`, optional `stream_id`.
- [x] Store actor/audit fields, requested timestamp, started timestamp, completed timestamp, progress JSON, error JSON, and fencing token.
- [x] Add claim semantics with `FOR UPDATE SKIP LOCKED`, claim owner, claim TTL, and retryable failure policy.
- [x] Change admin projection rebuild routes to enqueue and return `202 Accepted` with `operationId`.
- [x] Add operation read endpoints for list/detail/progress.
- [x] Add worker runner(s) to process queued projection operations.
- [x] Ensure operation workers publish status snapshots so the admin UI can display progress without triggering live drains.
- [x] Tests: operations route returns `202`, operation is persisted, worker claims once, stale claims are reclaimed, completed operations are immutable except retention metadata.

### 2. Rebuild Lease Coordination And Fencing

- [x] Define a canonical projection runner lease name function shared by workers and projection operations.
- [x] Before rebuild/reset, acquire the same `projection-group:<context>.<projection>` lease used by normal workers, or add an operation-level exclusive lease that workers honor.
- [x] Ensure workers do not run a projection group while an operation lease for the same projection is active.
- [x] Add an operation fencing token to reset/checkpoint/ledger mutation calls.
- [x] Add DB-side fencing checks to checkpoint deletion, checkpoint save, ledger deletion, ledger claim, and projection snapshot/status writes where applicable.
- [x] Add `AbortSignal` propagation to long rebuild/drain loops and stop promptly when lease renewal fails.
- [x] Add statement timeouts for projection operation transactions so expired workers cannot keep committing long after losing lease.
- [x] Tests: active worker blocks rebuild claim, rebuild blocks worker run, stale owner cannot overwrite newer checkpoint/status, lease loss aborts operation before reset or drain.

### 3. Generation-Based Rebuild Semantics

- [x] Add projection generation metadata table keyed by target context and projection group.
- [x] Track `active_generation`, `rebuilding_generation`, `state`, `started_at`, `cutover_at`, and `operation_id`.
- [x] Extend projection group contracts with reset/rebuild strategy metadata instead of implicit no-op reset.
- [x] Define table strategy types:
  - `generation-column`: table includes `projection_generation` and reads filter active generation.
  - `shadow-table`: rebuild writes to generated/shadow table then swaps via view or metadata.
  - `truncate-safe`: only allowed for explicitly operator-hidden or non-user-facing tables.
  - `append-only-no-reset`: only allowed for outbox/audit tables that must not be cleared.
- [x] Fail startup when a projection group owns tables but does not declare a rebuild strategy.
- [x] Update default reset to fail closed for owned tables instead of returning no-op.
- [x] Implement generation cutover transaction that atomically marks the new generation active only after caught up.
- [x] Retain old generation until a cleanup job confirms cutover and retention window.
- [x] Add runbook steps for failed rebuild, rollback to previous generation, and cleanup.
- [x] Tests: successful generation cutover retains the previous generation until cleanup; failed generation rebuild does not cut over or clear the active generation.

### 4. Event Store Query And Index Alignment

- [x] Extend `ReadAllInput` normalization to derive `stream_context_name` from stream prefixes.
- [x] Update `buildReadAllSql` to include `stream_context_name = ANY(...)` when stream prefixes share normalized context names.
- [x] Keep `stream_category = ANY(...)` for category-level pruning.
- [x] Keep final `stream_id LIKE prefix || '%'` as correctness guard.
- [x] Add or revise indexes so the leading columns match actual predicates:
  - `(stream_context_name, stream_category, event_type, global_position)`
  - optionally `(stream_context_name, stream_category, global_position)` when event type is absent.
- [x] Sync `schema.sql` into generated `schema.ts`.
- [x] Add event-store tests for context predicate generation and parameter ordering.
- [x] Add a production-like `EXPLAIN` script or test fixture for catalog backlog queries.
- [x] Capture accepted query plans in `docs/architecture/event-projection-query-plans.md`.

### 5. Ledger Write Amplification And Retention

- [x] Move ledger compaction out of the generic hot runner group into a scheduled retention job with explicit cadence and batch limits.
- [x] Add indexes for retention scans by `projection_key`, `status`, and `global_position`.
- [ ] Future scale follow-up: consider partitioning `event_subscription_applications` by projection key hash or global-position range before table size becomes painful.
- [ ] Future scale follow-up: add batch prefetch/claim path for events in a drain batch while preserving per-event handler transaction boundaries.
- [ ] Future scale follow-up: add bulk completion for already-applied/no-handler/blocked-stream scan advancement where no side effect occurred.
- [x] Keep poison and transient records retained until explicitly resolved or retention policy allows compaction.
- [x] Expose ledger metrics: rows by status, oldest started row, compaction lag, claim conflict count, completion fencing failures.
- [x] Tests: compaction respects checkpoint and retention window, poison rows are not compacted, batch claim cannot double-apply under concurrent workers.

### 6. Async Admin Rebuild UX And Operations API

- [x] Change admin rebuild buttons to submit durable operations and navigate/show operation status.
- [x] Show operation state, projection target, actor, started/completed time, progress, and last error.
- [x] Add cancel request support for queued/running rebuilds.
- [x] Add operation history filters by context, projection, state, and actor.
- [x] Keep the default projections page snapshot-first; do not trigger live refresh on page load.
- [x] Lazy-load operation details and blocked-stream details only when an operator opens them.
- [x] Tests: UI normalizes queued/running/succeeded/failed/cancelled states; rebuild actions are asynchronous API operations instead of held-open requests.

### 7. Product Measure Direct Repair Transaction Boundary

- [x] Decide whether direct `resolveCatalogItemMeasures` without event context remains a supported repair path.
- [x] Prefer event-first resolution for normal paths: compute measures, append `catalog.catalog-item.product-measures-resolved`, let projection update read model.
- [x] If direct repair remains, wrap delete plus insert replacement in one transaction.
- [x] Make replacement helper accept a transaction-capable DB/client.
- [x] Add an idempotency test for repeated direct repair with the same measures.
- [x] Add crash-simulation/unit test ensuring partial delete/insert cannot be observed or committed.
- [x] Document direct repair as operator-only and event-first as the standard application path.

### 8. Worker Capacity Enforcement

- [x] Add startup validation for each worker deployable: sum of runner group concurrency must be less than or equal to context DB pool max, with configurable reserved connection budget.
- [x] Fail fast by default in staging/prod when over capacity.
- [x] Allow local/test override only through explicit env such as `ALLOW_WORKER_OVER_POOL_CAPACITY=true`.
- [x] Emit structured logs and health metadata for configured concurrency, active runner count, lease misses, DB pool max, and over-capacity status.
- [x] Apply the same validation to `platform-worker` and `admin-support-worker`.
- [x] Add tests for pass, fail, and explicit local override.
- [x] Update DigitalOcean env defaults and docs to match enforced capacity.

### 9. Applicable Lag Metrics

- [x] Rename existing count in API/contract as `sourceLagEventCount` while keeping `outstandingEventCount` as deprecated compatibility alias for one release if needed.
- [x] Implement `applicableLagEstimate` for filtered subscriptions.
- [x] Start with efficient estimate strategies:
  - exact count with event type/context/category predicates and capped timeout for operator refresh;
  - fallback to `null` plus reason when estimate would be too expensive.
- [x] Include `sourceHeadGlobalPosition`, `lastGlobalPosition`, `sourceLagEventCount`, and `applicableLagEstimate`.
- [x] Add UI labels that clearly separate scan backlog from applicable backlog.
- [x] Add tests for unfiltered subscriptions, event-type filters, stream-prefix filters, and timeout fallback.

### 10. Explicit Projection Transaction Contract

- [x] Introduce a stricter projection handler type where the transaction-scoped DB is required for handlers that mutate read models.
- [x] Keep `createProjectionAwarePool` as compatibility support during migration, but make new handlers use explicit context DB.
- [x] Add test guard that transactional projection handlers fail when called without the transaction-scoped DB.
- [x] Update handler builders to accept a projection DB resolver or use required handler context.
- [x] Mark side-effecting ports as forbidden inside projection handlers unless they are durable outbox writes in the same transaction.
- [x] Add tests proving handler writes and ledger completion commit or roll back together.
- [x] Document projection handler ACID rules in architecture docs and context projection authoring guidance.

### 11. Observability And Operations Safety

- [x] Add metrics for projection operation queue depth, oldest queued operation, active operations, operation failures, and operation duration.
- [x] Add metrics/log events for runner lease acquisition misses, lease renew failures, and fencing-sensitive runner failures.
- [ ] Future observability follow-up: add rate metrics for processed events per second, scan events per second, and ledger writes per event.
- [x] Add structured logs with operation ID, projection key/name, target context, worker ID, owner ID, stream ID when present, and fencing token.
- [x] Add alerts/runbook thresholds for stalled rebuild, growing backlog with idle workers, poison count growth, and ledger compaction lag.
- [x] Add admin affordances to retry/cancel operation and retry blocked stream without forcing full rebuild.

### 12. Verification Matrix

- [x] Unit tests for event-store SQL, ledger claim/complete, reset strategies, operation queue claims, and capacity validation.
- [x] Integration tests for concurrent worker plus rebuild operation.
- [x] Integration tests for failed rebuild preserving old generation.
- [x] Integration tests for poison stream isolation during rebuild/replay.
- [x] Admin route tests for enqueue/status/cancel instead of synchronous rebuild.
- [x] Catalog product-measure transaction tests.
- [x] Worker tests for lease fencing and over-capacity failure.
- [ ] Manual staging verification: enqueue rebuild for one projection, observe worker-owned progress, verify page remains responsive, verify no active generation cutover until caught up.
- [ ] Manual staging verification: large catalog backlog drains while applicable/source lag metrics move as expected.

## Documentation To Promote

- `docs/architecture/event-projection-operations.md`: operation queue, leases, fencing, rebuild generation model, handler ACID rules.
- `docs/architecture/event-projection-query-plans.md`: readAll query shapes, indexes, and accepted production-like plans.
- `docs/runbooks/projection-operations.md`: rebuild, replay, retry blocked stream, cancel operation, failed rebuild recovery, generation cleanup.
- `docs/README.md`: add links to the new architecture and runbook docs.
- Optional ADR: generation-based projection rebuilds and worker-owned projection operations, if the implementation chooses shadow/generation cutover as the canonical long-term direction.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
