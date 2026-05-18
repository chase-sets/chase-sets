# Source Observation Action Bar Alignment

## Intent

Fix the source-observation filter/action bar alignment at the design-system level so data-heavy admin bars keep labeled fields, filter buttons, and bulk actions on a single visual baseline without screen-specific overrides.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-source-observation-action-bar-alignment`
- Branch: `codex/source-observation-action-bar-alignment`
- Sandbox id: `0e9def9e`; doctor passed.
- Dependency setup status: complete via `pnpm run deps:install`.
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`.
- Setup blockers: none known.

## Owning Contexts

- Catalog owns Source Observations and the admin review workflow.
- `packages/design-system` owns the reusable `FilterBar` layout pattern; the screenshot issue is cross-surface UI chrome, not Catalog behavior.

## Resolved Decisions

- Ownership: keep behavior and Source Observation language in Catalog, but fix alignment in the design-system `FilterBar`.
- UI pattern: `FilterBar` should use a wrapping CSS grid with bottom alignment, stable min widths, and an action group that can push to the row end on wider screens.
- Compatibility: preserve existing `children` and `actions` API so current bounded-context consumers do not need local overrides.
- Source Observations: route the promote-all control through the Catalog shell's `filterActions` slot so the action lands in the design-system action region instead of masquerading as a filter.

## Implementation Checklist

- [x] Install worktree dependencies and run sandbox doctor.
- [x] Update `FilterBar` layout classes.
- [x] Add/adjust design-system coverage for the admin filter/action baseline.
- [x] Route Source Observation promote-all through the filter action slot.
- [x] Run focused design-system and Source Observation list tests.

## Documentation To Promote

- No durable docs expected; this is a design-system implementation refinement.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
