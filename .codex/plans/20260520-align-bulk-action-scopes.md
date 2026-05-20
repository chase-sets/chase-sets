# Align Catalog Bulk Action Scopes

## Intent

Make Catalog Items bulk actions consistent across scopes: selecting rows should show the same bulk actions as acting on the full matching result set, with only the target scope changing.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-align-bulk-action-scopes`
- Branch: `codex/align-bulk-action-scopes`
- Base: freshly fetched `origin/main` at `c429c888`
- Sandbox id: `9a93f5df`
- Dependency setup status: `pnpm run deps:install` completed successfully on 2026-05-20
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none; `pnpm run sandbox:doctor` completed successfully on 2026-05-20

## Owning Contexts

- Catalog owns Catalog Item bulk workflow behavior, filter-vs-id selection contracts, and UI composition for its admin list page.
- The design system already owns the reusable single `BulkActionSurface`/`BulkActionPanel` primitives; this change should not add new design-system primitives unless the Catalog implementation reveals a reusable gap.

## Resolved Decisions

- The mismatch is in Catalog Items UI composition: selected scope uses `selectedOperationOptions` and a separate selected action layout, while matching scope uses `matchingOperationOptions` and a separate `Preview matching drafts` secondary button.
- The shared action set should be identical for matching and selected scopes. Scope-specific behavior belongs in the handler, not in a different menu.
- `Publish`, `Archive`, and shared edit actions already have both id-selection and filter-selection backend paths.
- `Remove drafts` currently has only selected-row behavior through individual `RemoveDraftCatalogItem` commands. To keep the menus identical without adding an unsafe filter-wide delete endpoint in this pass, move `Remove drafts` out of the shared bulk action menu. It can remain a selected-scope secondary command if needed, but it should not make the selected bulk action menu differ from matching.
- `Retire` is not backed by a Catalog Item lifecycle runtime action on current main; Catalog Item domain documentation and detail UI use `Archive`. Remove `Retire` from the shared Catalog Items bulk action menu instead of preserving a broken option.
- Matching publish becomes the shared `Publish` action with a filter scope, not a separate secondary button.
- Filter-scope publish now preserves the selected result-set filters at the route/read-model boundary and relies on preview classification to block non-draft Catalog Items, matching selected-row publish behavior.

## Implementation Checklist

- [x] Replace separate selected/matching operation option arrays with one shared Catalog Item bulk action option array.
- [x] Render selected actions through `BulkActionPanel`, matching the full-result-set panel shape.
- [x] Route the shared action through selected ids or current filter selection based on scope.
- [x] Keep a selected-only secondary `Remove drafts` affordance, while not treating it as part of the shared bulk action menu.
- [x] Update tests to prove both scopes expose the same bulk action menu and that publish works for full result set and selected rows.
- [x] Run focused Catalog and design-system-adjacent verification.

## Verification Evidence

- `pnpm exec vitest run --config ./tests/vitest.config.mjs features/catalog-items/ui/catalog-item-list-page.test.tsx features/catalog-items/api/route.test.ts --reporter=verbose` passed: 15 tests.
- `pnpm exec vitest run --config ./tests/vitest.config.mjs --reporter=dot` passed: 25 files, 177 tests; 1 acceptance file/4 tests skipped by existing environment gating.
- `pnpm --filter @chase-sets/design-system exec vitest run src/__tests__/design-system.test.tsx --reporter=verbose` passed: 59 tests, including one-bottom-bar enforcement and the reusable side-panel pattern.
- `pnpm run check:localization` passed.
- `pnpm run check:structure` passed.
- `pnpm run verify:typecheck` passed.
- `pnpm --filter @chase-sets/app-admin-web run build` passed.
- Browser-level localhost check was not run because sandbox admin web `http://localhost:11152` was not listening in this worktree session.

## Documentation To Promote

- This plan records the scope decision. No durable glossary or architecture doc is expected unless implementation introduces a new cross-screen pattern.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
