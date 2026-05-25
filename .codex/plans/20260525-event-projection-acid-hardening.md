# Event Projection ACID And Scalability Hardening

## Intent

Close the remaining correctness and scalability gaps in the eventing and projection system after the projection runtime hardening work. The target architecture is:

- publishers append durable facts and do not know about consumers;
- projection consumers own catch-up, idempotency, poison isolation, replay, and operations state;
- ACID is enforced where required by keeping event application, read-model writes, ledger writes, and checkpoint semantics explicit;
- operators see fresh, actionable backlog and rebuild state without causing incident-time database pressure;
- bounded contexts own business handlers and read models, while shared infrastructure owns generic event-store, worker, lease, ledger, and operations mechanics.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/20260525-event-projection-acid-plan`
- Branch: `codex/event-projection-acid-plan`
- Base: freshly fetched `origin/main` at `8cf06bc6baac8f114449a2fef60a5e20c9d71eb7`
- Sandbox id: `1880fc96`.
- Dependency setup status: installed with `node ./scripts/worktree-deps.mjs install`.
- pnpm store path: default embedded worktree store `.codex/worktrees/.chase-sets-pnpm-store` when implementation begins.
- Setup blockers: none. `pnpm run sandbox:doctor` passes.

## Owning Contexts

- Shared runtime ownership: `infrastructure/bounded-context-runtime`, `infrastructure/platform-runtime`, `infrastructure/event-core-postgres`, and `contracts/event-core` own generic event-store schema, subscription application ledgers, worker leases/fencing, projection operations, checkpointing, and compatibility projector mechanics.
- Catalog ownership: `bounded-contexts/catalog/features/product-measures` owns Product Measure Profile and Resolved Product Measure behavior. Catalog decides whether resolved measure state is source truth, a derived read model, or a published fact.
- Bounded-context handler ownership: each context owns its projection handlers and read-model tables. Transaction-aware handler migration must happen inside owning contexts, not in deployables.
- Deployable ownership: `deployables/platform-worker`, `deployables/admin-support-worker`, `deployables/platform-api`, and `deployables/admin-support-api` only wire configuration, process composition, and internal status endpoints.

## Resolved Decisions

- Treat `schema.sql` and generated `schema.ts` drift as a release-blocking infrastructure defect.
- Keep the event-driven standard: do not restore publisher-driven projection draining.
- Make subscription application claims concurrency-safe before further throughput work; correctness comes first.
- Fencing must protect both operator state and side effects. Lease ownership alone is insufficient if long batches continue after lease loss.
- Handler migration should be mechanical and context-owned. The runtime can supply a transaction-scoped DB, but handlers must opt into it by using that DB for writes.
- Legacy projectors should be either migrated to bounded-context subscriptions or backed by the same ledger and transaction contract. A permanently separate non-ledger runtime is not acceptable.
- Commands that require atomic DB state plus event append should use either a single transaction-scoped event-store unit of work or move DB state mutation behind an event-derived projection. Mixing direct read-model mutation and later event append is not acceptable for source facts.
- Operations should show both global drain lag and applicable backlog when known. Global lag is useful but should not be labeled as business work.

## Specific Solutions By Finding

### P1: Event-store indexes are missing from deployed schema source

Solution:
- Make `infrastructure/event-core-postgres/schema.sql` the canonical schema source and regenerate `schema.ts` from it.
- Add or extend a metadata check so `pnpm run verify:metadata` fails when `schema.ts` and `schema.sql` diverge.
- Regenerate `schema.ts` with the missing indexes:
  - `event_store_events_tenant_type_global_idx`
  - `event_store_events_stream_prefix_global_idx`
- Add a regression test that `composeModuleSchemaSql` includes those indexes because runtime bootstrapping uses `eventCorePostgresSchemaSql`.
- Add a short runbook note for applying schema-only fixes when runtime SQL and generated schema drift.

Files:
- `infrastructure/event-core-postgres/schema.sql`
- `infrastructure/event-core-postgres/schema.ts`
- `infrastructure/bounded-context-runtime/index.test.ts`
- `scripts/sync-workspace-metadata.mjs` or a new schema sync script invoked by it
- `docs/runbooks/projection-operations.md`

Verification:
- `pnpm run verify:metadata`
- `pnpm --filter @chase-sets/bounded-context-runtime test`
- `pnpm --filter @chase-sets/event-core-postgres test`

### P1: Subscription application ledger is unsafe under overlapping workers

Solution:
- Replace the separate outside status read plus inside status read with one transaction-scoped claim API.
- Implement `claimSubscriptionApplication(client, projectionKey, event)` that:
  - inserts a `started` row when absent;
  - locks the row or uses `INSERT ... ON CONFLICT ... RETURNING` semantics to determine ownership;
  - returns `already-applied` without invoking the handler when another transaction has already completed the event;
  - never transitions `applied` back to `started`;
  - records poison/transient completion only for a row this attempt claimed.
- Use the claim result in both normal drain and blocked-stream retry paths.
- Add concurrency tests with two runners applying the same event. Exactly one handler invocation should occur, and the loser should advance via ledger state.
- Keep checkpoint advancement after successful application transaction commit.

Files:
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/bounded-context-runtime/index.test.ts`

Verification:
- New overlapping-worker ledger race test.
- Existing poison/retry/checkpoint tests.
- `pnpm --filter @chase-sets/bounded-context-runtime test`

### P1: Worker fencing protects lease rows, not side effects

Solution:
- Extend `WorkerRunner.runOnce` to accept a runner context containing:
  - `fencingToken`;
  - `ownerId`;
  - `AbortSignal`;
  - `throwIfLeaseLost()`.
- Abort the signal when lease renewal fails. Runners must check it before each event application, before checkpoint save, and before rebuild/reset operations.
- Make `recordRunnerStatus` fenced: updates should only succeed for the current owner/fencing token or a strictly newer token. Stale workers must not overwrite newer state.
- Make `recordProjectionStatusSnapshot` fenced or at least monotonic by fencing token/update time so stale workers cannot publish old snapshots over newer ones.
- Add tests for:
  - lease lost during a long projection batch stops before the next event;
  - stale status write does not overwrite a newer owner;
  - stale snapshot does not replace a newer snapshot.

Files:
- `infrastructure/platform-runtime/worker.ts`
- `infrastructure/platform-runtime/worker.test.ts`
- `infrastructure/platform-runtime/control-plane.ts`
- `infrastructure/platform-runtime/control-plane.test.ts`
- `contracts/event-core/projector.ts`
- `infrastructure/bounded-context-runtime/index.ts`

Verification:
- `pnpm --filter @chase-sets/platform-runtime test`
- `pnpm --filter @chase-sets/bounded-context-runtime test`
- `pnpm --filter @chase-sets/event-core test`

### P1: Projection handlers do not use the transaction-scoped DB

Solution:
- Add a small helper in shared projection contracts, for example `resolveProjectionDb(context, fallbackDb)`, that returns `context.db ?? fallbackDb`.
- Mechanically migrate handlers from captured `db.query(...)` to `const projectionDb = resolveProjectionDb(context, db)` and use `projectionDb.query(...)`.
- Update `ProjectorHandler` examples and docs to show two-argument handlers as the standard.
- Add a static check that flags projection handler modules that import `ProjectorHandlerMap` and do not reference the transaction-aware helper.
- Prioritize high-volume and multi-step handlers first:
  - Catalog item/admin projections;
  - Discovery search/item-detail/category projections;
  - Pricing source projections;
  - Inventory catalog projections;
  - Checkout catalog/cart/sell-list projections;
  - Marketplace catalog/account/listing/offer projections.
- Then migrate the remaining handlers context-by-context.

Files:
- `contracts/event-core/projector.ts`
- `bounded-contexts/*/features/**/projection*.ts`
- `bounded-contexts/*/support/**/projection*.ts`
- `docs/architecture/event-projection-runtime.md`
- `docs/runbooks/projection-operations.md`
- structure/static check scripts

Verification:
- Context projection tests for migrated handlers.
- Static check proving no target handler bypasses the transaction helper.
- `pnpm run test:fast`

### P1: Legacy projectors remain a large non-ledger surface

Solution:
- Extract the subscription application ledger into a reusable projection application service that both bounded-context subscriptions and legacy `createProjector` can use.
- Extend `createProjector` with optional transaction/application-ledger support:
  - transaction-scoped handler context;
  - same claim/apply/poison semantics as subscriptions;
  - batched checkpointing retained;
  - lease abort checks.
- Add a deprecation warning or static check for new raw `createProjector(` call sites unless they opt into the ledger path or are explicitly marked test/seed-only.
- Create a migration inventory for the 59 current call sites with owner, event types, stream prefixes, side-effect risk, and whether they should become bounded-context subscriptions.
- Convert high-volume cross-context projectors to projection groups first. Leave low-volume slice-local projectors on the ledger-backed compatibility path temporarily.

Files:
- `contracts/event-core/projector.ts`
- `contracts/event-core/projector.test.ts`
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/event-core-postgres/projection-store.ts` or equivalent shared ledger storage
- `bounded-contexts/*/index.ts`
- `bounded-contexts/*/context.json`

Verification:
- Legacy projector duplicate-application crash-window test.
- Legacy projector overlapping-worker test.
- `rg "createProjector\\("` count included in plan/PR description.

### P1: Command flows mix state mutation and event append without ACID

Solution:
- Refactor Catalog Product Measures so source fact emission and resolved read-model state are not split by a partial failure.
- Preferred domain model:
  - compute the resolved product measure snapshot;
  - append `catalog.catalog-item.product-measures-resolved` as the source fact with deterministic stream/version semantics;
  - project `catalog_resolved_product_measures` from that event using the normal projection runtime.
- If the resolved table must remain command-owned state, introduce a transaction-scoped Postgres event-store unit of work so read-model mutation and event append commit in the same database transaction.
- Remove `expectedVersion: "any"` from this flow unless duplicate resolution events are intentional and modeled. Use loaded stream version, deterministic idempotency key, or a command id.
- Add tests for crash windows:
  - failure before event append leaves no resolved table mutation;
  - retry does not duplicate events;
  - event replay rebuilds `catalog_resolved_product_measures`.

Files:
- `bounded-contexts/catalog/features/product-measures/api/runtime.ts`
- `bounded-contexts/catalog/features/product-measures/api/runtime.test.ts`
- Catalog product-measure projection/read-model files
- `infrastructure/event-core-postgres/event-store.ts` if transaction-scoped append is chosen
- `docs/architecture/event-projection-runtime.md`

Verification:
- Product-measure runtime tests.
- Catalog projection replay tests.
- Event-store transaction tests if unit-of-work path is chosen.

### P2: Prefix filtering may still scan poorly

Solution:
- After schema drift is fixed, capture `EXPLAIN (ANALYZE, BUFFERS)` for representative high-volume filters:
  - event type only;
  - tenant plus event type;
  - stream prefix plus global position;
  - event type plus stream prefix plus global position.
- Replace the `EXISTS (SELECT FROM unnest(...))` predicate with a query shape that can use indexes predictably. Candidate implementation:
  - generate bounded `OR stream_id LIKE $n || '%'` clauses for prefix filters; or
  - add normalized generated columns such as `stream_category` and `stream_subject` and filter on `stream_category`.
- Prefer normalized stream category/source fields for long-term scale; keep `streamPrefixes` as compatibility input that maps to normalized filters when possible.
- Add DB-profile tests that assert filtered reads pass the intended parameters and include the expected SQL predicate shape.

Files:
- `infrastructure/event-core-postgres/event-store.ts`
- `infrastructure/event-core-postgres/event-store.test.ts`
- `infrastructure/event-core-postgres/schema.sql`
- `infrastructure/event-core-postgres/schema.ts`
- `docs/architecture/event-projection-runtime.md`

Verification:
- DB profile tests.
- Stored EXPLAIN fixtures or runbook evidence.

### P2: Ledger work is per-event and write-heavy

Solution:
- Prefetch application statuses for the filtered batch with one query:
  - `SELECT event_id, status FROM event_subscription_applications WHERE projection_key = $1 AND event_id = ANY($2)`.
- Skip already-applied events before opening handler transactions.
- Use the new claim API for non-applied events, so correctness is preserved even with the prefetch race.
- Batch checkpoint writes remain by `checkpointBatchSize`.
- Move ledger compaction to happen at most once per runner turn, and consider a separate low-priority maintenance runner if compaction becomes visible in query timing.
- Add metrics/operation fields for:
  - inspected events;
  - applicable events;
  - skipped-applied events;
  - handler-applied events;
  - checkpoint writes.

Files:
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/bounded-context-runtime/index.test.ts`
- `docs/runbooks/projection-operations.md`

Verification:
- Unit tests prove applied statuses are prefetched once per batch.
- Existing idempotency tests still pass.

### P2: Snapshot-first operations can show stale or incomplete projection state

Solution:
- Build the operations response from the runtime's declared projection group list, then overlay fresh worker snapshots by projection key.
- Define a freshness cutoff, for example active worker heartbeat age plus one polling interval, with a conservative absolute cap such as 2 minutes.
- Mark each group as `fresh-snapshot`, `stale-snapshot`, or `runtime-memory`.
- Do not let one existing snapshot switch the entire page to snapshot-only mode.
- Include snapshot age, owner, runner name, and freshness classification in the UI/API.
- Keep the explicit `/refresh` path for live recompute.

Files:
- `infrastructure/platform-runtime/projection-operations-routes.ts`
- `infrastructure/platform-runtime/projection-operations-routes.test.ts` or app tests
- `deployables/admin-web/app/routes/projection-operations.tsx`
- API tests under `deployables/platform-api` and `deployables/admin-support-api`

Verification:
- Tests with partial snapshots, stale snapshots, no snapshots, and fresh snapshots.
- Admin web type/build checks.

### P2: Rebuild/reset is not an atomic cutover

Solution:
- Add projection rebuild operation state:
  - `queued`, `resetting`, `replaying`, `cutting-over`, `succeeded`, `failed`;
  - started/finished timestamps, actor, target context, projection name, revision, error.
- During rebuild, operations status should show `rebuilding` instead of normal caught-up/behind semantics.
- For critical user-facing read models, move to generation-based or shadow-table rebuild:
  - write rebuilt rows into a new generation;
  - validate catch-up;
  - atomically flip active generation;
  - garbage collect old generation after success.
- Keep default destructive truncate only for explicitly low-risk internal/admin read models until each context opts into generation-aware rebuild.
- Add context-owned reader gates where needed so readers either serve the previous generation or return a clear stale/rebuilding response instead of partial empty state.
- Add rebuild failure tests that prove the old active generation remains readable.

Files:
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/platform-runtime/projection-operations-routes.ts`
- `bounded-contexts/*/context.json` projection group metadata
- high-risk read model schemas and readers in Catalog, Discovery, Marketplace, Inventory, Checkout
- `docs/architecture/projection-rebuild-replay.md`
- `docs/runbooks/projection-operations.md`

Verification:
- Runtime rebuild state tests.
- One pilot generation-based rebuild test for a high-value projection group.
- Follow-up migration inventory for remaining groups.

### P3: Outstanding event count is global lag, not applicable lag

Solution:
- Rename current value in APIs/types to `globalOutstandingEventCount` or `sourceGlobalLag`.
- Add `applicableOutstandingEventCount` when the runtime can compute it with the same filters used by `readAll`.
- For expensive counts, support bounded/exact semantics:
  - exact count for indexed event-type filters;
  - capped count such as `10000+` when the runtime stops counting at an operator-safe threshold;
  - `unknown` when the predicate is not safe to count.
- Surface both in operations UI:
  - global lag: how far the checkpoint is behind the source head;
  - applicable backlog: how many matching events likely need handler work.
- Keep worker scheduling priority on applicable backlog when known, otherwise global lag.

Files:
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/event-core-postgres/event-store.ts`
- `infrastructure/platform-runtime/worker.ts`
- `infrastructure/platform-runtime/projection-operations-routes.ts`
- `deployables/admin-web/app/routes/projection-operations.tsx`
- docs/runbook updates

Verification:
- Tests for filtered applicable count vs global lag.
- UI build/typecheck.

## Implementation Sequence

1. [x] Fix schema source drift and add schema drift CI guard.
2. [x] Implement concurrency-safe subscription application claiming.
3. [x] Add worker lease abort context and fenced status/snapshot writes.
4. [x] Reduce per-event ledger reads through batch status prefetch while preserving the claim API.
5. [x] Add fresh/stale/partial snapshot overlay in operations.
6. [ ] Rename global lag and add applicable backlog metrics.
7. [~] Migrate high-volume handlers to transaction-scoped DB helper. Shared helper added and Catalog item read-model handlers migrated first; remaining handlers stay explicit follow-up work.
8. [ ] Extract shared projection application ledger and apply it to legacy `createProjector`.
9. [ ] Convert high-volume legacy projectors to bounded-context subscriptions or ledger-backed compatibility.
10. [ ] Refactor Catalog Product Measures to event-first projection or transaction-scoped event-store unit of work.
11. [x] Capture production-like prefix-filter `EXPLAIN` evidence and adjust SQL/index strategy. SQL shape is changed to index-friendlier explicit prefix predicates; production EXPLAIN capture remains an operational verification item.
12. [ ] Add rebuild operation state.
13. [ ] Pilot generation-based atomic rebuild on one high-value projection group.
14. [ ] Promote docs and runbooks.
15. [ ] Run full CI verification and deploy.

## Delivered Implementation Slice

- Regenerated deployed event-core Postgres schema from `schema.sql` and made metadata verification fail on future SQL/export drift.
- Added transaction-owned subscription application claiming so overlapping workers skip already-applied events instead of re-running handlers.
- Added batch application-status prefetch to reduce per-event ledger reads while preserving the claim API as the correctness gate.
- Added worker run context with lease-loss abort checks and fenced runner/snapshot control-plane writes.
- Changed projection operations to start from declared runtime groups and overlay only fresh worker snapshots; stale snapshots become metadata rather than authoritative state.
- Changed stream-prefix event-store filtering from `unnest()` to explicit prefix predicates so the new `text_pattern_ops` index has a cleaner path.
- Added `resolveProjectionDb` and migrated the high-volume Catalog item read-model projection handlers to use transaction-scoped DB handles when the runtime supplies one.

## Deferred From This Slice

- Applicable backlog counts and API field rename from `outstandingEventCount` to a clearer global/applicable lag pair.
- Full projection-handler migration across all bounded contexts.
- Legacy `createProjector` ledger compatibility.
- Catalog Product Measures event-first or transaction-scoped event-store refactor.
- Rebuild operation state and generation-based atomic cutover.

## Verification Plan

Targeted:
- `pnpm --filter @chase-sets/event-core-postgres test`
- `pnpm --filter @chase-sets/event-core test`
- `pnpm --filter @chase-sets/bounded-context-runtime test`
- `pnpm --filter @chase-sets/platform-runtime test`
- `pnpm --filter @chase-sets/app-platform-api test:fast`
- `pnpm --filter @chase-sets/app-admin-support-api test`
- Context-specific tests for Catalog Product Measures and migrated projection handlers.

Full:
- `pnpm run verify:metadata`
- `pnpm run verify:static`
- `pnpm run typecheck`
- `pnpm run test:fast`
- `pnpm run verify:build`

Operational:
- PR CI green.
- Staging deploy green.
- Projection operations page shows fresh/stale snapshot state.
- Staging worker status reports lease abort/fencing metrics.
- Confirm event-store indexes exist in staging and production with direct schema inspection or migration logs.

## Documentation To Promote

- `docs/architecture/event-projection-runtime.md`: concurrency-safe claim, transaction-aware handler standard, applicable backlog semantics, legacy compatibility contract.
- `docs/architecture/stream-isolated-projection-errors.md`: clarify poison ledger claim behavior under overlap and retry.
- `docs/architecture/projection-rebuild-replay.md`: rebuild state machine and generation-based cutover standard.
- `docs/runbooks/projection-operations.md`: schema drift checks, snapshot freshness, applicable vs global lag, rebuild states, prefix-filter EXPLAIN process.
- Catalog docs if Product Measures source/read-model ownership changes.

## Stress Tests

- Overlapping workers apply the same event: one handler invocation, one applied ledger row, monotonic checkpoint.
- Worker loses lease mid-batch: old worker aborts before next event/checkpoint; new worker continues from durable state.
- Stale worker status write arrives after new owner: status and snapshot remain owned by the newer fence.
- Large filtered backlog: applicable backlog count is accurate or explicitly capped/unknown; global lag remains visible.
- Handler crash after read-model write but before ledger completion: transaction-aware handler rolls back both.
- Legacy projector crash after handler success: ledger-backed compatibility skips duplicate side effects on replay.
- Product Measures failure between compute and event append: retry does not duplicate source facts or leave partial read-model truth.
- Rebuild fails after reset/replay begins: old active generation remains readable for generation-aware projections.

## Open Questions

None blocking for the recommended implementation path. The only implementation choice to confirm during execution is whether Catalog Product Measures should become fully event-first or use a transaction-scoped event-store unit of work. Recommended answer: event-first, with `catalog.catalog-item.product-measures-resolved` as the fact that projects `catalog_resolved_product_measures`.

## Goal Completion Criteria

For the implementation goal, do not mark complete until:

- PR submitted for the completed implementation.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for the worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
