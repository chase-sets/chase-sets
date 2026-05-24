# Consumer-Owned Catalog Projections

## Intent

Make Catalog Source Observation promotion, import, reapply, review, and shared Catalog bulk operations follow distributed-system projection ownership: publishers append durable events and complete command/job work; projector consumers own read-model catch-up independently through worker runners.

The production symptom was a long bulk promotion that reported roughly 30k promoted observations in the action surface while the Catalog Integrations and Catalog Items read models showed only hundreds. The system should make that state diagnosable and should not depend on browser pages or publisher-side projector drains for projection progress.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260524-consumer-owned-projections`
- Branch: `codex/consumer-owned-projections`
- Base: `origin/main` at `7f2e177e` (`Overhaul catalog integrations seeding (#272)`)
- Sandbox id: `a0841d6b`
- Dependency setup status: complete via `pnpm run deps:install`
- Sandbox doctor: passed

## Repo Evidence

- `bounded-contexts/catalog/context.json` declares `drainProjectorsOnWrite: false` and lists `admin-support-worker` and `platform-worker` as runtime deployables.
- `bounded-contexts/catalog/features/source-observations/api/runtime.ts` was still draining Catalog Item, Source Observation, and Reference Data projectors after import, promotion, reapply, reject, and reference hierarchy writes.
- `bounded-contexts/catalog/support/runtime-support/bulk-lifecycle.ts` and `bounded-contexts/catalog/features/catalog-items/api/runtime.ts` also drained projectors after production bulk command execution.
- `infrastructure/platform-runtime/worker.ts` collected projectors and projection groups as worker runners, but drained one runner until it reported no more work before releasing the lease.
- `contracts/event-core/projector.ts` already processes checkpointed batches; `infrastructure/event-core-postgres/projection-store.ts` stores checkpoints monotonically, so projector consumers can safely own catch-up.

## Resolved Decisions

- Projection ownership: projector consumers own read-model catch-up. Command handlers, provider imports, background review jobs, and admin bulk actions must not call local projectors to make their own writes visible.
- Completion language: job and bulk completion means durable command/event work is complete. It must not imply every projection surface has caught up.
- Worker fairness: worker scheduling should give every runner bounded turns. A runner that keeps finding work should be rescheduled by the loop instead of holding its lease until fully caught up.
- Poison events: do not silently skip failed projection events. Projection errors should remain visible through worker runner status.
- Read-after-write exceptions: seed/test helpers may keep explicit drains because they are deterministic setup tools, not production command publishers.
- Reference hierarchy: provider-created TCGdex Series and Expansion Reference Records now use deterministic provider ids before falling back to projection-backed provider-attribute lookup. This avoids same-job duplicate records without requiring publisher-owned drains.

## Implementation Checklist

- [x] Remove production Source Observation publisher calls to `drainRuntimeProjectors(...)` from promotion, reapply, reject, import, and reference hierarchy paths.
- [x] Remove shared Catalog bulk lifecycle and Catalog Item bulk edit projector drains.
- [x] Keep seed/test drains outside production runtime behavior.
- [x] Update Source Observation and admin bulk docs to state that completion is event durability and projections catch up independently through workers.
- [x] Add focused Source Observation runtime tests proving command paths do not invoke projector drains.
- [x] Add worker-runtime tests proving runner loop fairness: a busy runner that reports work yields after one run so other projectors/jobs get turns.
- [x] Update worker loop implementation to one leased `runOnce` per scheduled runner turn, recording active/caught-up status without draining a runner to zero inside the scheduler.
- [x] Run focused Catalog Source Observation, bulk lifecycle, Catalog Item, Reference Data, and platform-runtime worker tests.
- [x] Run structure/type/static checks required by the touched surfaces.

## Goal Completion Criteria

- PR submitted for the completed implementation.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local sandbox/worktree/branches cleaned up after merge.
