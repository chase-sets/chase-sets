# Catalog Bulk Action Surface

## Intent

Replace the Catalog Items double bottom action bar with one reusable bulk action surface. The design should keep the current scope visible, expose the most common action directly, and move many or advanced bulk actions into a side sheet or compact menu pattern owned by the design system.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-catalog-bulk-action-surface`
- Branch: `codex/catalog-bulk-action-surface`
- Sandbox id: `6c3a306a`
- Dependency setup status: `pnpm run deps:install` completed successfully on 2026-05-20
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known; `pnpm run sandbox:doctor` completed successfully on 2026-05-20

## Owning Contexts

- Catalog owns the Catalog Items admin workflow, selection scope, preview contracts, and bulk edit/lifecycle behavior.
- Design system owns the reusable `BulkActionBar` hierarchy, panel/menu primitives, and any guardrail that prevents multiple bottom action bars in one bulk slot.

## Resolved Decisions

- A screen gets one active bulk action surface per list slot. Catalog Items currently violates this by rendering `BulkLifecycleActionBar` and a second `BulkActionBar` for matching-scope bulk edits when no rows are selected.
- The shared `BulkActionBar` remains the canonical bottom action surface for data-heavy admin screens.
- Many possible bulk actions should not sprawl inline. Keep the selected/matching count visible, keep a single primary trigger visible, and move action choice plus required fields into a design-system side sheet for configuration-heavy sets. Lightweight secondary commands can stay in secondary actions or overflow menu items.
- Catalog Items should compose lifecycle and bulk edit matching-scope actions through one bar. Selected-row flows should also use the same progressive pattern where practical.
- Implementation adds `BulkActionSurface` as the one-bar guard and `BulkActionPanel` as the reusable side-sheet pattern for large bulk action sets.
- Catalog list pages wrap their bulk action slot in `BulkActionSurface`; Catalog Items now uses one matching-scope `BulkActionBar` with a side-panel action picker for lifecycle and shared edit actions.

## Repo Evidence

- `packages/design-system/README.md` says admin screens should use `BulkActionBar`, advanced/risky/low-frequency choices should use progressive disclosure, and panel interactions must use `SideSheet`, `BottomSheet`, `Menu`, or related canonical primitives.
- `packages/design-system/src/components/data-display/filter.tsx` already exposes `BulkActionBar` with `primaryActions`, `secondaryActions`, and `overflowActions`.
- `bounded-contexts/catalog/features/catalog-items/ui/catalog-item-list-page.tsx` renders two sibling bottom bars for matching Catalog Items: one through `BulkLifecycleActionBar` and one direct `BulkActionBar` for bulk edits.
- `bounded-contexts/catalog/docs/admin-bulk-workflows.md` documents that Catalog Items support both lifecycle previews and shared edits such as assigning blueprints/categories and tag operations.

## Implementation Checklist

- [x] Add a design-system bulk action configuration panel/pattern or strengthen `BulkActionBar` so complex action sets can use a side sheet without custom per-screen layout.
- [x] Add a design-system regression test proving a bulk action region may not render multiple direct `BulkActionBar` surfaces.
- [x] Refactor Catalog Items to render only one bottom bulk action surface for matching-scope actions.
- [x] Move the many matching-scope edit choices into the progressive panel/pattern while preserving lifecycle previews and current selected-row behavior.
- [x] Add Catalog Items regression coverage for exactly one matching bottom action bar and the bulk edit preview flow through the new panel.
- [x] Run focused tests for the design system and Catalog Items UI.

## Verification

- `pnpm run deps:install` completed successfully.
- `pnpm run sandbox:doctor` completed successfully for sandbox `6c3a306a`.
- Rebased onto `origin/main` on 2026-05-20 and preserved the mainline `Preview matching drafts` action as a secondary action inside the single matching-scope bar.
- `pnpm --filter @chase-sets/design-system run test` passed after rebase: 2 files, 121 tests.
- `pnpm --filter @chase-sets/catalog run test` passed after rebase: 25 files passed, 1 skipped; 176 tests passed, 4 skipped.
- `pnpm run check:no-any` passed.
- `pnpm run check:localization` passed.
- `pnpm run check:structure` passed.
- `pnpm exec tsc -p packages/design-system/tsconfig.json --noEmit --pretty false --skipLibCheck` passed.
- `pnpm run verify:typecheck` and `pnpm --filter @chase-sets/design-system run typecheck` timed out without diagnostics in this environment and remain unproven.

## Documentation To Promote

- Update `packages/design-system/README.md` if the final component contract adds a named bulk action side sheet/panel pattern.
- Keep this plan with the branch and implementation.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
