# Event Projection Runtime Hardening

## Intent

Harden the eventing and projection system so publishers append durable facts and return quickly, while independent projection consumers drain, checkpoint, repair, replay, and report their own operational state. The work addresses the reviewed performance, scalability, maintainability, and idempotency findings without moving projection-specific policy into deployables.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/20260525-event-projection-hardening`
- Branch: `codex/event-projection-hardening`
- Base: freshly fetched `origin/main` at `62cdeda3`
- Sandbox id: `175deef4`
- Dependency setup status: installed with `node ./scripts/worktree-deps.mjs install`; `pnpm run sandbox:doctor` passed
- pnpm store path: default embedded worktree store `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Shared runtime ownership: `infrastructure/bounded-context-runtime`, `infrastructure/platform-runtime`, `infrastructure/event-core-postgres`, and `contracts/event-core` own generic projection consumption, checkpointing, application ledgers, worker scheduling, operations status, and event-store adapters.
- Deployable composition roots: `deployables/platform-api`, `deployables/platform-worker`, `deployables/admin-support-api`, and `deployables/admin-support-worker` only wire runtime behavior, configuration, and health surfaces.
- Bounded contexts: each context continues to own its projection handlers, read-model tables, projection groups, and projection revision bumps. This follows `bounded-contexts/README.md`, `docs/architecture/bounded-context-structure.md`, `docs/architecture/projection-rebuild-replay.md`, and `docs/architecture/stream-isolated-projection-errors.md`.

## Resolved Decisions

- Projection consumers remain independent consumers. Publishers must not synchronously drain projection groups as a general write-path behavior.
- `strict-per-stream` remains the default projection error policy: poisoned events block only the affected projection plus source stream, while unrelated streams keep draining.
- Generic mechanics belong in shared infrastructure; business meaning, table ownership, and projection revisions remain context-owned.
- Implementation should prefer breaking changes where they reduce entropy: legacy projectors should be migrated or wrapped rather than preserved as a parallel runtime indefinitely.

## Specific Solutions By Finding

### P1: API writes can still synchronously drain projections

Solution:
- Change `WRITE_CONSISTENCY_DRAIN_ENABLED` default from `true` to `false` in platform API config.
- Treat `drainProjectorsOnWrite` as an explicit exceptional compatibility flag rather than normal consistency behavior.
- Keep `attachWriteConsistencyMiddleware` and consistency headers as the normal read-your-writes contract.
- Add tests proving non-GET/HEAD writes do not call `drainContextRuntime` by default and still emit commit-position headers when events are committed.
- Add durable documentation that read-after-write flows use commit-position headers and bounded loader retries, not publisher-driven projector drain.

Files:
- `deployables/platform-api/src/config.ts`
- `deployables/platform-api/src/app.ts`
- `deployables/platform-api/__tests__/config.test.ts`
- `deployables/platform-api/__tests__/app.test.ts`
- `docs/api/marketplace-api.md`
- `docs/architecture/stream-isolated-projection-errors.md`

### P1: Projection side effects and application ledger updates are not atomic

Solution:
- Add a shared transaction helper to `infrastructure/event-core-postgres` so runtime code can consistently execute `BEGIN`/`COMMIT`/`ROLLBACK` with a transaction-scoped `PgPoolClient`.
- Extend projection handler invocation to support a transaction-scoped execution context while preserving source compatibility for handlers that only accept the event.
- In subscription runtime, claim/mark application start, invoke the handler, mark application applied, and persist any per-event application state in the same target-context transaction.
- Keep checkpoint advancement after the transaction commits. If checkpoint save fails after an applied ledger row, replay skips the already-applied event through the ledger and advances later.
- Check `rowCount` for ledger completion and fail loudly if the ledger row was not claimed.
- Add tests for crash-window behavior: handler succeeds but checkpoint is stale; second run must skip handler side effects and advance.

Files:
- `infrastructure/event-core-postgres/types.ts`
- `infrastructure/event-core-postgres/index.ts`
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/bounded-context-runtime/index.test.ts`
- `contracts/event-core/projector.ts`

### P1: Large legacy projector surface bypasses the new subscription runtime

Solution:
- Introduce a compatibility wrapper for legacy `createProjector` that supports filtered reads, batched checkpoints, stream-isolated poison handling, and application-ledger idempotency using the same runtime primitives as subscriptions.
- Add a migration inventory generated from the 57 current `createProjector(` call sites, grouped by owning bounded context and feature.
- Convert high-volume and cross-context read-model projectors first: Catalog, Discovery, Pricing, Inventory, Checkout, and Marketplace.
- Leave slice-local low-volume projectors on the wrapper only temporarily, with a deprecation warning and a plan to delete raw unfiltered projector use.
- Add a structure or lint check that forbids new raw `createProjector` call sites outside the approved compatibility wrapper.

Files:
- `contracts/event-core/projector.ts`
- `contracts/event-core/projector.test.ts`
- `infrastructure/bounded-context-runtime/index.ts`
- `bounded-contexts/*/context.json`
- `bounded-contexts/*/index.ts`
- representative converted features under `bounded-contexts/catalog`, `bounded-contexts/discovery`, `bounded-contexts/pricing`, `bounded-contexts/inventory`, `bounded-contexts/checkout`, and `bounded-contexts/marketplace`

### P1: Multi-worker lease misses overwrite useful runner state

Solution:
- Stop writing global runner status `skipped` when a worker fails to acquire a lease.
- Preserve the current owned runner status until the lease holder updates it, or until status is classified stale by heartbeat/lease age.
- Add local loop metrics for lease misses without writing misleading shared state.
- Extend worker tests with two-worker contention: worker B lease miss must not overwrite worker A `running`.

Files:
- `infrastructure/platform-runtime/worker.ts`
- `infrastructure/platform-runtime/worker.test.ts`
- `infrastructure/platform-runtime/control-plane.ts`
- `infrastructure/platform-runtime/control-plane.test.ts`

### P1: Split worker loops may overrun shared-resource capacity by default

Solution:
- Make per-group concurrency defaults fit the existing DB pool by default rather than summing above it.
- Recommended defaults for shared-resource environments: projections `2`, jobs `1`, dispatch `1`, scheduled `1`, with explicit env overrides for larger workers.
- Add startup validation that warns when `projection + job + dispatch + scheduled` exceeds a configured fraction of `DATABASE_POOL_MAX`.
- Expose configured and active runner concurrency per group through `/internal/workers/status`.
- Document DigitalOcean shared-resource tuning guidance and when to split projections/jobs into separate deployables.

Files:
- `deployables/platform-worker/src/config.ts`
- `deployables/platform-worker/__tests__/config.test.ts`
- `deployables/admin-support-worker/src/config.ts`
- `deployables/admin-support-worker/__tests__/config.test.ts`
- `deployables/platform-worker/src/main.ts`
- `docs/runbooks/projection-operations.md`

### P2: Operations refresh still performs live projection refresh work

Solution:
- Add worker-published projection status snapshots in the control plane. Workers update snapshots after runner batches and heartbeat cycles.
- Change the projection operations GET route to read snapshots by default without calling `refreshProjectionGroupStatuses`.
- Add an explicit operator action for live refresh/recompute when needed, protected by existing projection operations permissions.
- Show snapshot freshness, worker owner, last updated time, source head, checkpoint, outstanding global lag, and state in the API/UI payload.
- Keep blocked-stream and poison-event detail reads targeted to selected projection keys.

Files:
- `infrastructure/platform-runtime/control-plane.ts`
- `infrastructure/platform-runtime/projection-operations-routes.ts`
- `infrastructure/platform-runtime/worker.ts`
- `infrastructure/bounded-context-runtime/index.ts`
- `deployables/platform-api/__tests__/app.test.ts`
- operations UI files under the admin support surface

### P2: Stream-prefix filtering may not scale with current SQL/indexes

Solution:
- Add event-store query-plan tests or documented `EXPLAIN` fixtures for representative high-volume filters.
- Add a Postgres index optimized for prefix scans where stream-prefix filtering remains necessary. Candidate: `stream_id text_pattern_ops` plus global-position support, validated with `EXPLAIN`.
- Prefer normalized stream category/source columns in a future migration if query plans show prefix matching remains expensive at scale.
- Add composite indexes for common filtered scans, especially event type plus global position and tenant plus event type plus global position when tenant filtering is used.

Files:
- `infrastructure/event-core-postgres/schema.sql`
- `infrastructure/event-core-postgres/event-store.ts`
- `infrastructure/event-core-postgres/event-store.test.ts`
- `docs/architecture/event-projection-runtime.md`

### P2: Application ledger will grow quickly and has minimal operational indexes

Solution:
- Add operational indexes for projection/status/error queries, including `(projection_key, status, updated_at)` and status/global-position paths used by operations.
- Add retention/compaction for applied ledger rows older than the durable checkpoint and outside the replay safety window.
- Keep poison/transient rows until resolved or explicitly cleared by rebuild/replay.
- Document ledger retention and replay consequences: compacted applied rows depend on checkpoint durability; reset/rebuild clears or supersedes ledger rows for the projection key.

Files:
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/bounded-context-runtime/index.test.ts`
- `docs/architecture/projection-rebuild-replay.md`
- `docs/runbooks/projection-operations.md`

### P2: Subscription groups run source subscriptions sequentially

Solution:
- Run independent subscriptions inside a projection group with bounded concurrency.
- Preserve deterministic ordering for subscriptions with explicit `order`: execute same-order subscriptions concurrently, then advance to the next order group.
- Keep projection group revision reset and mark-synced logic outside the concurrent section.
- Add tests for slow-source isolation and ordered subscription preservation.

Files:
- `infrastructure/platform-runtime/worker.ts`
- `infrastructure/platform-runtime/worker.test.ts`
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/bounded-context-runtime/index.test.ts`

### P2: Manifest filters and handler maps can drift silently

Solution:
- Add startup validation in `resolveModuleSubscriptions`: every handler event type must be included by declared `eventTypes` when `eventTypes` is present.
- Prefer deriving `eventTypes` from handler keys when declarations omit them.
- Fail fast with context name, projection name, subscription name, missing event types, and manifest path guidance.
- Add tests proving mismatches fail before workers start and cannot silently advance checkpoints past applicable events.

Files:
- `contracts/bounded-context-module/index.ts`
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/bounded-context-runtime/index.test.ts`
- context manifests with intentional test fixtures

### P3: Source-head race can temporarily report inconsistent status

Solution:
- Replace the short-read catch-up assignment with `max(lastGlobalPosition, capturedSourceHead)` so in-memory status never moves backward.
- Recompute source head after a short read only when needed for accurate outstanding counts.
- Add a regression test where `readAll` returns an event beyond the captured head.

Files:
- `infrastructure/bounded-context-runtime/index.ts`
- `infrastructure/bounded-context-runtime/index.test.ts`

## Implementation Checklist

1. [x] Add or update architecture/runbook docs first so implementation follows the documented projection-consumer model.
2. [x] Disable default API write drain and update app/config tests.
3. [x] Fix lease-miss status semantics and worker contention tests.
4. [x] Fix source-head status race.
5. [x] Add projection subscription filter validation.
6. [~] Add shared transaction helper and make subscription handler plus ledger application atomic. Runtime now supplies a transaction-scoped handler context; migrating existing handlers remains.
7. [x] Add application-ledger indexes and retention/compaction mechanics.
8. [x] Add control-plane projection status snapshots and make operations routes read snapshots by default.
9. [x] Tune worker concurrency defaults and expose saturation/capacity status.
10. [~] Add event-store prefix/index improvements with query-plan evidence. Indexes are added; production-like `EXPLAIN` evidence remains.
11. [x] Add bounded-concurrency execution inside projection groups.
12. [~] Introduce legacy projector compatibility wrapper and migrate the highest-volume projector call sites. `createProjector` now filters by handler event type and batches checkpoints for all existing call sites; per-context migration remains.
13. [x] Run targeted runtime, worker, event-store, API config, and bounded-context acceptance tests.
14. [x] Run full repo verification required by CI before PR.

## Verification Log

- `node ./scripts/worktree-deps.mjs install`: passed.
- `pnpm run sandbox:doctor`: passed for sandbox `175deef4`.
- `pnpm --filter @chase-sets/event-core test`: passed, 8 tests.
- `pnpm --filter @chase-sets/bounded-context-runtime test`: passed, 26 tests.
- `pnpm --filter @chase-sets/platform-runtime test`: passed, 122 tests and 3 skipped.
- `pnpm --filter @chase-sets/event-core-postgres test`: passed, 10 tests.
- `pnpm --filter @chase-sets/app-platform-api test:fast`: passed, 45 tests.
- `pnpm --filter @chase-sets/app-admin-support-api test`: passed, 12 tests.
- `pnpm --filter @chase-sets/app-platform-worker test:fast`: passed, 11 tests.
- `pnpm --filter @chase-sets/app-admin-support-worker test:fast`: passed, 3 tests.
- `pnpm run typecheck`: passed.
- `git diff --check`: passed.
- `pnpm run test:fast`: passed repo-wide. Existing CSS parser warnings appeared during the run, but the command exited successfully.
- `pnpm run verify:metadata`: passed.
- `pnpm run verify:static`: passed.
- `pnpm run verify:build`: passed. Existing Vite chunk-size warnings appeared for web bundles, but the command exited successfully.

## Documentation To Promote

- `docs/architecture/event-projection-runtime.md`: canonical runtime architecture, consumer model, transaction/idempotency guarantees, and status semantics.
- `docs/runbooks/projection-operations.md`: worker tuning, backlog diagnosis, snapshot freshness, replay/rebuild, poison repair, ledger retention, and DigitalOcean shared-resource guidance.
- Updates to `docs/architecture/stream-isolated-projection-errors.md` for atomic application and ledger compaction semantics.
- Updates to `docs/architecture/projection-rebuild-replay.md` for legacy migration and ledger cleanup behavior.
- Updates to `docs/README.md` for any new durable docs.

## Stress Tests

- Normal flow: API writes append events and return without waiting for projections; workers drain asynchronously; read-after-write clients use commit-position headers.
- Partial flow: projection handler succeeds but checkpoint save fails; ledger prevents duplicate side effects and later run advances.
- Stale data: operations page shows snapshot age and does not create incident-time DB pressure.
- Replay: rebuild clears projection-owned tables, checkpoints, poison state, and superseded ledger rows for that projection key.
- Poison event: strict-per-stream blocks only the poisoned stream for that projection; unrelated streams continue.
- Cross-context handoff: source contexts publish facts; downstream contexts own read-model interpretation and repair.
- Shared-resource deploy: default concurrency stays below pool pressure and is observable.

## Open Questions

None currently blocking. The recommended implementation path is to land this as staged PRs if the full scope becomes too large for one reviewable branch: first runtime correctness and operator-state fixes, then operations snapshots and indexes, then legacy projector migration.

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
