# Projection Rebuild Replay

## Intent

Enable projections to rebuild themselves when their projection definition changes, without requiring operators to remember a manual checkpoint reset. The rebuild path should use the existing projection group model: a bounded context declares the projection name, source contexts, owned read-model tables, and bootstrap importance; shared runtime orchestration decides when to reset and replay.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260521-projection-rebuild-replay`
- Branch: `codex/projection-rebuild-replay`
- Sandbox id: `84ab710f`
- Dependency setup status: Complete; `pnpm run deps:install` succeeded.
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: None. `pnpm run sandbox:doctor` passed.

## Owning Contexts

- Shared projection orchestration is owned by `@chase-sets/bounded-context-runtime`.
- Projection checkpoint storage is owned by `@chase-sets/event-core-postgres`.
- Projection declarations remain in the bounded context that owns the read model.
- Deployables remain thin composition roots and should not own projection change policy.

## Resolved Decisions

- Add an explicit projection revision to projection group declarations. The revision is context-owned metadata, not inferred from source code hashes, because bounded contexts are the canonical home for read models and because intentional revisions should survive formatting-only code changes.
- Persist projection group rebuild state next to subscription checkpoints in the target context database. This keeps rebuild detection with the replay/runtime orchestration, not in deployables.
- Automatically rebuild a projection group during projection-group sync when the persisted revision differs from the declared revision. Rebuild means truncate owned tables, reset subscription checkpoints, replay subscriptions, and then persist the new revision after successful catch-up.
- Preserve the existing subscription version as the source-subscription contract version. Projection revision is broader: it represents the whole target read model shape across one or more subscriptions and owned tables.
- Use the existing `ownedTables` reset contract. A projection group with destructive reset disabled or missing owned tables would be an unsafe future enhancement and is out of scope for this pass.

## Repo Evidence

- `bounded-contexts/README.md` says each bounded context owns its read models and tests, and cross-context interaction happens through stable IDs and published integration events.
- `docs/architecture/bounded-context-structure.md` reserves shared top-level infrastructure for generic adapters while bounded contexts own read-model schemas, projections, and table naming.
- `contracts/bounded-context-module/index.ts` already exposes `BcProjectionGroupDeclaration`, `BcProjectionGroup`, `ownedTables`, and optional custom `reset`.
- `infrastructure/bounded-context-runtime/index.ts` already resolves projection groups, syncs them, resets subscriptions, rebuilds groups, reports statuses, and composes the `event_subscription_checkpoints` schema.
- `infrastructure/event-core-postgres/projection-store.ts` supports simple projector checkpoints but has no projection-definition revision metadata.
- Context manifests already declare projection groups and subscription versions, for example `bounded-contexts/inventory/context.json`.

## Implementation Checklist

- [x] Extend projection group contracts with `projectionRevision`.
- [x] Add runtime persistence for projection group revision state.
- [x] Include the new schema in context database bootstrap.
- [x] Teach sync/rebuild to detect stale revisions, rebuild first, and mark the revision only after successful replay.
- [x] Teach worker projection catch-up to run projection groups through the same revision-aware rebuild path instead of bypassing it with raw subscription runners.
- [x] Expose revision/stale state in projection group status and replay summaries.
- [x] Add focused runtime tests for unchanged revision, changed revision, failed rebuild, and manual rebuild revision marking.
- [x] Install worktree dependencies and run sandbox doctor.
- [x] Run targeted tests for bounded-context runtime and relevant type checks.

## Verification

- `pnpm run deps:install`
- `pnpm run sandbox:doctor`
- `pnpm --filter @chase-sets/bounded-context-runtime test`
- `pnpm --filter @chase-sets/platform-runtime test`
- `pnpm --filter @chase-sets/platform-runtime test -- worker.test.ts`
- `pnpm --filter @chase-sets/app-platform-api test -- app.test.ts`
- `pnpm exec tsc -p ./tsconfig.json --noEmit`
- `pnpm --filter @chase-sets/bounded-context-runtime exec tsc --noEmit`
- `pnpm --filter @chase-sets/platform-runtime exec tsc --noEmit`
- `pnpm run typecheck`

## Documentation To Promote

- [x] Add architecture documentation explaining when to bump projection revisions and what automatic rebuild does: `docs/architecture/projection-rebuild-replay.md`.
- [x] Update the curated docs map: `docs/README.md`.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
