# Design System Inset Surfaces

## Intent

Make one nested child surface permissible only as a recessed cutout/inset treatment, then fail tests when card-like surfaces are nested more deeply or when cards are used as nested child containers. Improve the existing UI by migrating nested card/surface patterns to the canonical design-system primitive.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-design-system-inset-surfaces`
- Branch: `codex/design-system-inset-surfaces`
- Sandbox id: `fc7c81fd`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none currently known

## Owning Contexts

- Design system package: owns the reusable surface primitives, styling, component exports, and design-system validation tests.
- Platform Operations: owns the projection operations admin UI shown in the review screenshots.
- Discovery: owns browse/search/detail UI and the marketplace hero/search surfaces shown in the review screenshots.
- Other bounded contexts: own their slice UI behavior and copy, but should consume design-system `Inset` for nested visual grouping instead of creating nested cards.

## Resolved Decisions

- Canonical term: `Inset`, not nested card. A card remains a standalone object; an inset is a recessed child surface inside one parent surface.
- Invariant: `Card`, `Surface`, and `DetailPanel` must not be direct or indirect descendants of `Card`, `Surface`, or `DetailPanel` unless the nested visual grouping is represented by `Inset`.
- Invariant: `Inset` may sit inside one parent `Card`, `Surface`, or `DetailPanel`, but `Inset` must not contain another `Inset` or any card-like surface.
- Styling: `Inset` uses the darker/recessed `surface-2` treatment, subtle border, smaller radius, and no elevation/glow so it reads like a cutout similar to fields/buttons.
- Enforcement: design-system tests should scan TSX usage and render component-level assertions so violations are errors, not taste-call regressions.
- Migration: replace nested metric/detail/list child cards with `Inset`; flatten any third-level framed regions into tables, lists, dividers, or spacing.

## Implementation Checklist

- [x] Install worktree dependencies and run sandbox doctor.
- [x] Update design-system `Inset` implementation and exports where needed.
- [x] Add surface hierarchy guard tests that fail on nested card-like surfaces and nested insets.
- [x] Migrate Platform Operations projection operation surfaces from nested cards/panels to insets.
- [x] Migrate design-system components that render child metric/fact boxes to `Inset`.
- [x] Migrate bounded-context nested cards/surfaces that break the new guard.
- [x] Update design-system docs to record the card/surface/inset rule.
- [x] Run design-system tests, typecheck, and focused impacted tests.

## Documentation To Promote

- `packages/design-system/README.md`: composition rule for one inset level only.
- Optional design-system pattern note if the implementation uncovers enough examples to justify a separate `SURFACES.md`.

## Verification

- `pnpm run sandbox:doctor`
- `pnpm run test:design-system`
- `pnpm --filter @chase-sets/design-system run typecheck`
- `pnpm --filter @chase-sets/platform-operations run typecheck`
- `pnpm --filter @chase-sets/experience run typecheck`
- `pnpm --filter @chase-sets/payments run typecheck`
- `pnpm --filter @chase-sets/platform-operations run test`
- `pnpm --filter @chase-sets/experience run test:fast`
- `pnpm --filter @chase-sets/inventory run test`
- `pnpm --filter @chase-sets/payments run test:fast`
- `pnpm run format:check`
- `pnpm run typecheck`

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
