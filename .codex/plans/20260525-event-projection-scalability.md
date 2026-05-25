# Event Projection Scalability And Operations

## Intent

Address the projection backlog findings from May 25, 2026 with a scalable event-driven projection runtime that keeps publishers unaware of projectors, lets projection consumers drain continuously and independently, gives operators truthful state, and preserves stream-isolated poison handling.

The immediate production symptom was projection subscriptions showing `idle` while catalog-backed projections had roughly 200k source-position lag each. Live staging evidence showed the corresponding projection group runners were processing batches, so the user-facing problem is both state-model accuracy and runtime throughput.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/20260525-event-projection-scalability`
- Branch: `codex/event-projection-scalability`
- Base: fetched `origin/main` at `23e868f0d6bd245c4b50025ea1a61b6ba5057861`
- Dependency setup status: `pnpm run deps:install` completed on May 25, 2026
- pnpm store path: default embedded worktree store, `.codex/worktrees/.chase-sets-pnpm-store`
- Sandbox id: `68cfe6bc`
- Setup blockers: none found; `pnpm run sandbox:doctor` passed

## Owning Contexts

- Shared runtime owners:
  - `infrastructure/bounded-context-runtime`: event subscription runners, projection groups, checkpointing, replay/rebuild/retry operations.
  - `infrastructure/event-core-postgres`: event store read APIs, event/projection schema, projection checkpoint store.
  - `infrastructure/platform-runtime`: worker scheduler, control plane, projection operations API.
  - `deployables/platform-worker` and `deployables/admin-support-worker`: thin composition roots for worker loops and env config.
  - `deployables/admin-web`: projection operations UI.
- Bounded contexts affected by the observed catalog backlog:
  - Catalog publishes canonical item/product/category/reference facts.
  - Marketplace, Discovery, Inventory, Pricing, and Checkout consume Catalog facts through projection groups declared in their `context.json` manifests.

## Repo Evidence

- Subscription status marks any non-caught-up, non-degraded subscription as `idle`: `infrastructure/bounded-context-runtime/index.ts` lines 683, 906, 1143.
- Worker runner status separately records `running` when a runner processes a batch: `infrastructure/platform-runtime/worker.ts` lines 242-256.
- Platform worker currently combines all runner kinds into one list: `deployables/platform-worker/src/main.ts` lines 134-140.
- Default worker concurrency is `WORKER_MAX_CONCURRENT_RUNNERS=4`: `deployables/platform-worker/src/config.ts` line 186.
- Subscription replay reads by global position with `sourceEventStore.readAll`: `infrastructure/bounded-context-runtime/index.ts` lines 1053-1056.
- Postgres `readAll` does not filter by event type or stream prefix: `infrastructure/event-core-postgres/event-store.ts` lines 134-140.
- Subscription filtering happens after event read: `infrastructure/bounded-context-runtime/index.ts` lines 1082-1087.
- Subscription checkpoints are upserted inside the per-event loop: `infrastructure/bounded-context-runtime/index.ts` lines 1128-1130.
- Projection operations refreshes groups and subscriptions sequentially: `infrastructure/bounded-context-runtime/index.ts` lines 1675-1680.
- Each subscription refresh reads source head with `SELECT MAX(global_position)`: `infrastructure/bounded-context-runtime/index.ts` lines 650-653.
- Worker heartbeat listing has no freshness filter: `infrastructure/platform-runtime/control-plane.ts` lines 218-225.
- Poison handling records blocked streams and defers later events on that stream: `infrastructure/bounded-context-runtime/index.ts` lines 1090-1101 and 1112-1124.
- The event store has useful global, tenant-global, stream, and event-type indexes but lacks an event-type/global compound index for filtered projection reads: `infrastructure/event-core-postgres/schema.sql` lines 43-53.

## Resolved Decisions

### P1: Idle Is Not A Reliable Operator State

Decision: Replace subscription `idle` for behind subscriptions with an explicit `behind` state, and derive UI-facing state from both subscription checkpoint lag and worker runner status.

Implementation:

- Extend `SubscriptionReplayState` to include `behind`.
- Set state to:
  - `degraded` when blocked streams or poison events are active.
  - `caught-up` when checkpoint equals source head.
  - `running` only for an active local run or a fresh control-plane runner status.
  - `behind` when checkpoint is below source head and no active run is observed.
  - `error` when the runner failed.
- Keep `idle` only for initialized-but-not-yet-run or local transitional state if still needed; do not show `idle` for positive backlog.
- In Projection Operations, show `Draining` when runner status is fresh and `last_processed > 0`, `Queued` when backlog exists with no fresh active runner, and `Stalled` when backlog exists but no matching runner has run within the stale threshold.
- Add tests around `refreshSubscriptionStatus`, group summary counts, and admin route rendering.

Consequence: Operators can distinguish "waiting its turn" from "actively draining" and "stalled," which directly fixes the screenshot confusion.

### P1: Projection Throughput Is Capped By One Shared Scheduler

Decision: Split worker execution into independent bounded-concurrency loops by runner class, with projection runners isolated from jobs and dispatchers.

Implementation:

- Replace the single `runners` list with typed runner groups:
  - `projectionRunners`: projection groups plus legacy projectors.
  - `bulkJobRunners`: catalog import/promotion/rejection jobs.
  - `notificationDispatchRunners`.
  - `transactionalEmailDispatchRunners`.
  - `scheduledJobRunners`.
- Add env config:
  - `WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS`, default 8.
  - `WORKER_JOB_MAX_CONCURRENT_RUNNERS`, default 2.
  - `WORKER_DISPATCH_MAX_CONCURRENT_RUNNERS`, default 2.
  - `WORKER_SCHEDULED_MAX_CONCURRENT_RUNNERS`, default 1.
  - Keep `WORKER_MAX_CONCURRENT_RUNNERS` as backward-compatible fallback.
- Prioritize projection runners with outstanding backlog, then round-robin caught-up runners to avoid starvation.
- Preserve per-runner leases so multiple workers can scale horizontally without double-running the same runner.
- Expose loop status per runner class through worker status and Projection Operations.

Consequence: Bulk source-observation jobs and dispatchers can no longer starve projection catch-up. Projection throughput scales horizontally by adding worker instances and vertically by raising projection concurrency within DB capacity.

### P1: Each Projection Scans The Same Source Event Log Independently

Decision: Add subscription-aware filtered event reads in the consumer runtime; do not couple publishers to projections.

Implementation:

- Extend the event store with `readAllMatching` or equivalent:
  - `afterGlobalPosition`.
  - `limit`.
  - optional `eventTypes`.
  - optional `streamPrefixes`.
  - optional `tenantId`.
- In Postgres, push event-type and stream-prefix predicates into SQL.
- Add indexes:
  - `(event_type, global_position)` for filtered reads.
  - Consider `(tenant_id, event_type, global_position)` if tenant-scoped projection reads become common.
  - Consider `stream_id text_pattern_ops` only if stream-prefix filtering materially affects production plans.
- Keep current `readAll` for generic legacy projectors.
- Update subscription runners to use the filtered read path when subscriptions declare filters.
- Use `EXPLAIN` locally or against a staging clone before rollout for the catalog-heavy subscription shapes.

Consequence: Catalog projections stop repeatedly loading irrelevant events. For the current catalog backlog, each projection still owns its checkpoint and consumer semantics, but it only reads events it declared interest in.

Deferred option: If filtered reads are not enough at larger scale, add a durable consumer-side fanout table maintained by a generic event subscription dispatcher. Publishers still append only domain events; the dispatcher, owned by infrastructure, materializes per-subscription delivery rows. Do not make command handlers or event publishers know about projectors.

### P1: Checkpoints Are Written Once Per Inspected Event

Decision: Move from per-event checkpoint writes to chunked checkpointing, guarded by projection idempotency.

Implementation:

- Add `subscription.checkpointBatchSize`, default 100 or the runner batch size.
- Persist checkpoints:
  - after each processed chunk.
  - at the end of `runOnce`.
  - immediately before returning from unrecoverable/transient errors only when no handler side effect for the current event was committed.
  - immediately when deferring events for an already-blocked stream if needed to prevent hot-looping.
- Add tests proving reduced checkpoint writes for a batch of N events.
- Pair this with the idempotency ledger below so replay after crash is safe even when checkpoint save lags handler side effects.

Consequence: Catch-up writes fall from one checkpoint upsert per event to roughly one per batch/chunk, without weakening at-least-once processing semantics.

### P2: Operations API Refresh Is Sequential And Expensive

Decision: Make projection status refresh bounded-concurrent and cache/batch source-head lookup per source context.

Implementation:

- Add a per-refresh source-head map keyed by source context/pool so all subscriptions reading Catalog share one head query.
- Refresh projection group statuses with bounded concurrency, default 4 or 8.
- Avoid loading blocked-stream details for every legacy projector on the top-level page. Only query details for projections/subscriptions with nonzero blocked or poison counts, and provide detail endpoints for drill-in.
- Move expensive applicable backlog counts to worker-maintained status snapshots instead of computing all counts synchronously in the API.
- Add timing logs for projection operations API refresh.

Consequence: The admin page no longer creates a thundering herd of status queries when projections are already behind.

### P2: Stale Workers Remain Visible

Decision: Treat worker heartbeats as status rows with freshness and hide stale rows by default in operator summaries.

Implementation:

- Add a helper that classifies worker heartbeats as `active`, `stale`, or `expired` based on heartbeat age and lease TTL.
- Return `workerStatus` metadata from the API without deleting history by default.
- Add an optional cleanup operation or background prune for expired heartbeat rows older than a conservative retention window.
- Update the UI to show active worker count prominently and stale workers in a collapsed diagnostics section.
- Add tests for stale heartbeat classification.

Consequence: Operators see actual available worker capacity instead of stale restart history.

### P2: Idempotency Is A Handler Convention

Decision: Add a projection application ledger and transaction boundary so the runtime enforces idempotent event application where possible.

Implementation:

- Add `event_projection_applications` to the projection schema:
  - `projection_key`.
  - `event_id`.
  - `stream_id`.
  - `stream_version`.
  - `global_position`.
  - `event_type`.
  - `status` in `started`, `applied`, `poison`, `transient`.
  - timestamps and error fields.
  - primary key `(projection_key, event_id)`.
- Before applying a handler, insert/acquire the application row. If already `applied`, skip handler and advance checkpoint.
- Run handler side effects and application-row completion in the same target DB transaction when handlers use a `PgTransactionalPool`.
- Convert known multi-step projection handlers that do delete-then-insert into transaction-aware handlers. Initial targets:
  - Discovery search blueprint dimensions.
  - Pricing order signal lines.
  - Pricing fulfillment signal lines.
- Keep `ON CONFLICT` upserts as the default handler style, but do not rely on every handler author remembering idempotency.
- Add tests for replay after handler success but before checkpoint save.

Consequence: The runtime remains at-least-once at the event delivery layer while making projection side effects effectively exactly-once per projection/event in the target database.

### P2: Poison Handling Is Stream-Isolated But Retry/Rebuild Semantics Need Hardening

Decision: Keep strict-per-stream as the default, but make retry, skip, and rebuild semantics explicit and auditable.

Implementation:

- Preserve current behavior: one poisoned event blocks only the same projection plus stream, while unrelated streams continue.
- Ensure same-stream later events are recorded as deferred and not applied until retry succeeds.
- On retry, replay from `firstBlockedStreamVersion`; skip already-applied events through the projection application ledger.
- Add operator actions:
  - retry blocked stream.
  - mark poison event ignored with reason.
  - rebuild one projection group.
  - rebuild all projection groups for a context.
- Add visible counters for blocked streams, poison events, deferred events, and oldest blocked age.
- Add tests for:
  - unrelated streams continue after one poison event.
  - same stream is deferred.
  - retry applies blocked tail in order.
  - ignored poison requires explicit reason.

Consequence: Poisoned events stop being ambiguous hidden debt. Operators can resolve them without scripts and without halting unrelated streams.

### P3: Outstanding Events Means Source-Position Lag

Decision: Rename and split lag metrics so the UI does not imply all outstanding source positions are applicable handler work.

Implementation:

- Keep existing `outstandingEventCount` as `sourceLagCount` or label it `Source lag`.
- Add `applicableBacklogCount` for subscriptions with SQL-filterable event types/prefixes.
- Add `unknown` or `not computed` when an applicable count would be too expensive.
- Add `lastProcessedGlobalPosition`, `sourceHeadGlobalPosition`, `eventsProcessedLastRun`, and `drainRatePerMinute`.
- Add UI copy and tests that distinguish source lag from applicable backlog.

Consequence: Operators can tell whether a projection is behind the source log broadly or has a large amount of relevant work left.

## Implementation Checklist

### Phase 1: Truthful Operations State

- [x] Add `behind` state to subscription and projection status types.
- [x] Update status derivation in subscription refresh, run completion, group summaries, and health summaries.
- [x] Merge control-plane runner status into Projection Operations UI as derived operator state.
- [x] Add stale worker classification.
- [x] Update admin Projection Operations UI labels.

### Phase 2: Worker Isolation And Scheduling

- [x] Introduce runner groups and separate loops in platform worker and admin-support worker.
- [x] Add per-runner-kind concurrency config with backward-compatible fallback.
- [x] Add backlog-aware projection prioritization while preserving round-robin fairness.
- [x] Extend worker status endpoint with per-loop active counts.
- [x] Add worker scheduler tests for backlog priority and no duplicate same-runner execution.

### Phase 3: Filtered Subscription Reads

- [x] Add event store contracts for filtered global reads.
- [x] Implement Postgres filtered reads with event-type/global indexes.
- [x] Update subscription runner to call filtered reads.
- [x] Add database and runtime tests proving only matching events are loaded/applied.
- [ ] Verify query plans for catalog-heavy subscriptions.

### Phase 4: Batch Checkpointing And Idempotency

- [x] Add projection application ledger schema and runtime APIs.
- [ ] Add transaction-aware projection application wrapper.
- [x] Add checkpoint chunking.
- [ ] Convert multi-step projection handlers to transaction-aware execution where needed.
- [x] Add crash/replay and duplicate-event tests.

### Phase 5: Poison Operations Hardening

- [ ] Add ignore-with-reason operation.
- [x] Strengthen retry blocked stream behavior using the application ledger.
- [ ] Add UI counters for deferred events and oldest blocked age.
- [x] Add retry/rebuild tests.
- [ ] Add ignore-with-reason tests after the operation exists.

### Phase 6: Metrics And Admin API Efficiency

- [ ] Batch source-head queries by source context.
- [x] Add bounded-concurrent status refresh.
- [ ] Add applicable backlog counts where efficient.
- [ ] Add API timing logs and tests.
- [x] Update Projection Operations copy to distinguish source lag, active workers, stale workers, and behind/running states.

## Verification

- `pnpm run deps:install` passed.
- `pnpm run sandbox:doctor` passed for sandbox id `68cfe6bc`.
- `pnpm --filter @chase-sets/bounded-context-runtime test -- --run` passed with 3 files and 21 tests.
- `pnpm --filter @chase-sets/event-core-postgres test -- --run` passed with 4 files and 8 tests.
- `pnpm --filter @chase-sets/platform-runtime test -- --run` passed with 10 files passed, 1 skipped, 117 tests passed, and 3 skipped.
- `pnpm run typecheck` passed across the workspace.
- `pnpm run verify:static` passed formatting, structure, localization, and script checks.
- `pnpm run test:fast` passed across the workspace.
- `pnpm run build` passed across the workspace.

## Deferred Follow-Up

- Run `EXPLAIN` against staging-size catalog event tables before raising projection concurrency substantially.
- Add a transaction-aware projection application helper and convert known delete-then-insert handlers to use it.
- Add operator-visible ignore-with-reason semantics for poison events.
- Add applicable backlog counts when they can be computed without making the operations page part of the incident load.
- Batch source-head lookups per operations API refresh.

## Documentation To Promote

- [x] Add an architecture note: `docs/architecture/event-projection-runtime.md`.
- [x] Add or update a runbook: `docs/runbooks/projection-operations.md`.
- [x] Update `docs/README.md` if adding either document to the curated docs map.

## Open Questions

None blocking for the plan. The recommended implementation path is to deliver this as two PRs if risk or CI time grows:

1. Operations truthfulness and scheduler isolation.
2. Filtered reads, checkpoint batching, idempotency ledger, and poison hardening.

If we keep it as one PR, phase boundaries should still be preserved in commits.

## Stress Test

- Normal flow: publishers append events only; workers consume through leases and filtered reads.
- Partial flow: if a worker restarts during a batch, checkpoints may lag but application ledger prevents duplicate projection side effects.
- Stale data: operations page shows stale worker age and stale runner status instead of implying capacity exists.
- Replay: projection rebuild truncates owned tables, resets checkpoints/application rows for the projection, and replays from source.
- Poison: unrelated streams continue, same-stream events defer, retry replays in stream order.
- Cross-context handoff: source contexts publish facts only; downstream contexts declare subscriptions in manifests.
- Low-value card economics: backlog drain must remain efficient enough for high-volume, low-margin catalog operations and bulk provider imports.

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
