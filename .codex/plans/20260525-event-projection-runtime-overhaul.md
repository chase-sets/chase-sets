# Event Projection Runtime Overhaul

## Intent

Make projections fully consumer-owned, asynchronous, replayable, and operationally visible. Publishers must not synchronously drain consumers. Projection handlers must run through bounded-context subscriptions with transactional ledger semantics. Legacy projector factories and adapters must be removed, even if deployed projections must be rebuilt.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260525-event-projection-runtime-overhaul`
- Branch: `codex/event-projection-runtime-overhaul`
- Base: freshly fetched `origin/main` at `a89f20ab Harden projection runtime ownership and status`
- Sandbox id: `9da8aad7`
- Dependency setup: `node ./scripts/worktree-deps.mjs install` completed.
- pnpm store: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: `pnpm run sandbox:doctor` completed.
- Setup blockers: none.

## Owning Contexts

- Runtime ownership: `infrastructure/bounded-context-runtime`, `infrastructure/platform-runtime`, `infrastructure/event-core-postgres`, `contracts/bounded-context-module`, `contracts/event-core`.
- Projection owners: every bounded context with `eventSubscriptions`, `projectionGroups`, or legacy `createProjector(` usage.
- High-risk product contexts: `catalog`, `notifications`, `pricing`, `inventory`, `discovery`, `marketplace`, `ordering`, `payments`, `settlement`, `identity`, `auth`, `checkout`, `commercial-terms`, `fulfillment`, `support`, `reputation`, `public-presence`, `experience`.

## Resolved Decisions

- Projection execution will be manifest-first. `context.json` event subscriptions and projection groups are the source of truth; deployables remain thin composition roots.
- Legacy `createProjector(` factories will be removed from bounded contexts and no worker/API runtime path will consume legacy projectors.
- Cross-context and self-context projections will run as bounded-context subscriptions with application ledger, stream-isolated poison handling, and transaction-scoped handler DB clients.
- Synchronous write drains will default off everywhere. Explicit read-your-writes endpoints should use consistency headers or targeted reads, not hidden global projection drain.
- Rebuild/reset must stop truncating live read tables in place. The runtime will use a rebuild state machine and non-destructive replay by default; table-destructive rebuilds require projection-owned generation/shadow cutover support.
- Each physical owned table must have exactly one projection group owner unless it is explicitly partitioned by source/generation. `notification_outbox` will have one owning notifications projection group.
- Event-store filtering will become category-aware. Stream metadata columns will be stored and indexed so subscription reads do not depend only on broad `LIKE prefix || '%'` scans.
- Ledger compaction will move out of hot drain loops into scheduled maintenance.
- Operations GET will be snapshot-first and cheap. Expensive blocked stream details will be lazy-loaded per projection.
- Operator lag language will split source drain distance from applicable work: `sourceLagEventCount` and `applicableLagEstimate`.

## Implementation Checklist

- [x] Disable admin-support synchronous write drains and align its config with platform API.
- [x] Remove legacy projector runtime surfaces from platform API/worker composition and bounded-context module contracts.
- [x] Convert all 53 bounded-context `createProjector(` call sites to bounded-context subscription handler sets.
- [x] Delete the legacy `createProjector` adapter path in `contracts/event-core/projector.ts`.
- [x] Migrate projection handler DB access to transaction-scoped execution by composing contexts with a projection-aware DB proxy and running handlers inside AsyncLocalStorage-backed subscription transactions.
- [x] Add subscription application claim semantics that return already-applied status so overlapping workers do not rerun applied events.
- [x] Add DB-recorded lease owner/fencing token to application/checkpoint writes.
- [x] Keep lease-loss checks around handler transactions and status-sensitive writes.
- [x] Replace destructive projection reset with non-destructive replay.
- [x] Merge notifications outbox projections into one `notification_outbox` owner.
- [x] Move product-measure resolution to event-first behavior with idempotent append and projected read-model updates.
- [x] Add stream context/category columns, backfill SQL, insert-time derivation, and composite indexes for filtered subscription reads.
- [x] Update `readAll` to use normalized stream metadata with `LIKE` as compatibility fallback.
- [x] Move subscription ledger compaction to a worker maintenance runner and remove compaction from hot drain.
- [x] Make projections operations GET snapshot-first and lazy-load blocked details from a dedicated endpoint.
- [x] Augment lag metrics with `sourceLagEventCount` and `applicableLagEstimate`; keep `outstandingEventCount` as a compatibility alias.
- [x] Add/update targeted tests for legacy removal, non-destructive rebuild, scheduled compaction, snapshot-first operations, and worker runner changes.
- [x] Add durable architecture/runbook/ADR docs for projection ownership, replay/rebuild, poison handling, and operations monitoring.

## Finding Coverage

- P1 admin-support synchronous drain: config gate plus default-off middleware wiring.
- P1 destructive rebuild/reset: runtime rebuild state and non-destructive replay; no automatic live table truncation.
- P1 shared `notification_outbox`: one owning projection group.
- P1 legacy projectors: all `createProjector(` call sites removed; composition consumes subscriptions only.
- P1 subscription atomicity: handlers use transaction-scoped DB; static guard prevents captured DB projection writes.
- P1 product-measure ACID gap: event-first/idempotent append and projected read model update.
- P2 advisory fencing: persisted owner/token on projection application and checkpoint writes, stale status overwrite protection, and bounded handler execution checks.
- P2 filtering scalability: normalized stream metadata and composite indexes with fallback compatibility.
- P2 ledger write pressure: hot compaction removed; scheduled retention/partition maintenance.
- P2 operations GET load: snapshot-first summary and lazy blocked detail route.
- P3 lag semantics: separate source lag from applicable lag estimate.

## Verification

- `pnpm run verify:static` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm run verify:test` passed.
- `pnpm run verify:test-db` passed.
- `pnpm run verify:build` passed.
- Targeted package tests passed while iterating: `@chase-sets/bounded-context-runtime`, `@chase-sets/platform-runtime`, `@chase-sets/event-core`, `@chase-sets/event-core-postgres`, `@chase-sets/app-platform-api`, `@chase-sets/app-admin-support-api`, `@chase-sets/identity`, `@chase-sets/checkout`, and the Catalog product-measures runtime test.

## Documentation To Promote

- `docs/architecture/event-projections.md`
- `docs/runbooks/projection-operations.md`
- `docs/adr/<next>-consumer-owned-projection-subscriptions.md`
- `docs/README.md` updates for curated links.

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
