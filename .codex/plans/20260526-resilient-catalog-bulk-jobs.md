# Resilient Catalog Bulk Jobs

## Intent

Make Catalog Source Observation background jobs complete under frequent CI/CD deployments. A deployment may stop workers at any time, so a large promotion, rejection, import, or reapply job must persist useful progress after bounded worker turns instead of restarting the whole selected scope.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-resilient-catalog-bulk-jobs`
- Branch: `codex/resilient-catalog-bulk-jobs`
- Sandbox id: not created
- Dependency setup status: complete (`pnpm run deps:install`; `pnpm run sandbox:doctor`)
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Catalog owns Source Observations, their review workflow, promotion into Catalog Items, read models, UI, and tests.
- Deployables remain thin worker composition roots. The restart-resilience behavior belongs in `bounded-contexts/catalog/features/source-observations`.

## Resolved Decisions

- Long-running Source Observation jobs should be processed as resumable worker turns, not one entire job per `runOnce`.
- Persisted job progress remains the source of truth for the UI and reconnect behavior.
- Each worker turn should process a bounded batch, update job progress/result, extend the job claim, and return. A later worker turn, including one after a deployment, continues from persisted job state.
- Use the existing Catalog job tables and JSON progress/result columns; avoid deployable-owned queues or new cross-context infrastructure.
- Filter-scoped jobs should re-resolve eligible rows each turn. Explicit-ID jobs should use persisted completed outcomes to skip already handled IDs.
- Completion occurs only when the persisted result count reaches the original requested total or when a refreshed filter scope has no eligible work remaining.
- Provider integration jobs need the same deployment-tolerant shape for broad imports and reapply work; process one expansion or bounded reapply batch per worker turn.

## Implementation Checklist

- [x] Install worktree dependencies and run sandbox doctor.
- [x] Add source-observation job helpers for persisted partial results and batch sizing.
- [x] Update bulk promote/reject job processing to process bounded batches and requeue unfinished jobs between turns.
- [x] Update integration import/reapply job processing to persist partial outcomes across turns.
- [x] Update docs to state bounded-turn progress semantics.
- [x] Add focused runtime tests for restart/resume across repeated worker turns.
- [x] Run targeted tests and static checks that cover the touched slice.

## Verification

- `pnpm run deps:install`
- `pnpm run sandbox:doctor`
- `pnpm exec vitest run bounded-contexts/catalog/features/source-observations/api/runtime.test.ts`
- `pnpm --filter @chase-sets/catalog run test`
- `pnpm run verify:typecheck`
- `pnpm run verify:static`

## Documentation To Promote

- `bounded-contexts/catalog/docs/admin-bulk-workflows.md`
- `bounded-contexts/catalog/docs/source-observation-integration.md`

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
