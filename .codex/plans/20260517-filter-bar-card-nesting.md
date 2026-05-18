# Filter Bar Card Nesting

## Intent

The desktop marketplace filter rail should read as one cohesive control surface. The current category/filter area places feature cards inside the sidebar's own glass surface, which creates a visually heavy card-within-card effect and weakens scanability. The fix should keep the Discovery-owned filters visible and reversible while moving the visual treatment into the canonical design-system marketplace filter pattern.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-filter-bar-card-nesting`
- Branch: `codex/filter-bar-card-nesting`
- Created from: source repo `main` at `e98c3101`
- Sandbox id: `0c07d788`
- Dependency setup: `pnpm run deps:install` completed.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox setup: `pnpm run sandbox:doctor` completed first on the default block, then rerun with `CHASE_SETS_SANDBOX_BASE_PORT=11300` because port `7220` was already owned by another running sandbox.
- Sandbox ports: marketplace `http://localhost:11303`, platform API `http://localhost:11312`, dev portal `http://localhost:11300`
- Setup blockers: none after moving this worktree to the `11300` port block.

## Owning Contexts

- Discovery owns this behavior because its README and glossary assign browse, search, Filter State, Facets, and facet presentation to Discovery.
- Catalog remains upstream for Category identity and item membership only. No Catalog model, event, or projection contract should change for this visual issue.
- The design system owns the reusable marketplace filter visual pattern. Discovery should keep composing design-system components instead of introducing route-local style overrides.
- Deployables remain thin composition roots and should not own or patch this UI behavior.

## Resolved Decisions

- Use Discovery language: this is a Facet presentation issue in the desktop filter rail, not a new domain concept.
- Preserve the previous product decision that focused desktop result pages keep the filter rail visible.
- Fix the nested-card problem at the design-system pattern level by making `MarketplaceFacetRail` render a section-level panel suitable for placement inside `Sidebar`, rather than each facet rendering another `Card`.
- Keep the existing `SearchResultsLayout` sidebar chrome because it provides the sticky, scrollable desktop filter container.
- Preserve `MarketplaceFacetChoiceGroup` and the mobile filter bottom sheet unless verification shows the same nested-surface issue there.
- No domain events, read-model changes, API changes, or localization term changes are expected.

## Repo Evidence

- `bounded-contexts/discovery/context.json` declares the `search` slice and marketplace search route contribution.
- `bounded-contexts/discovery/GLOSSARY.md` defines Facet, Filter, Filter State, Discovery Query, Result Set, and Search Result.
- `bounded-contexts/discovery/docs/dynamic-search-filters.md` says Discovery owns filter presentation while the design system owns the reusable mobile filter shell and choice-group presentation.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` passes a stack of `MarketplaceFacetRail` instances into `SearchResultsLayout`.
- `packages/design-system/src/patterns/app-shells.tsx` wraps desktop filters in `Sidebar`, and `Sidebar` renders a glass surface with border, radius, padding, and shadow.
- `packages/design-system/src/patterns/app-shells.tsx` currently renders each `MarketplaceFacetRail` as `Card variant="feature"`, producing the visible card-in-card effect from the screenshot.
- Existing tests cover the category rail staying visible and design-system parity for `MarketplaceFacetRail`; they should be updated only where markup expectations change.

## Open Questions

- None.

## Implementation Checklist

- Done: changed `MarketplaceFacetRail` in the design system so desktop facet groups render as flat sections inside the filter sidebar.
- Done: preserved button behavior, selected state, multi-select state, accessible pressed state, labels, and counts.
- Done: updated design-system parity coverage for the flattened facet rail semantics.
- Done: ran targeted design-system and Discovery search UI tests.
- Done: ran repo-level static typecheck.
- Done: visually verified the marketplace search page on desktop and mobile, with special attention to focused results and the filter sidebar.

## Implementation Notes

- `packages/design-system/src/patterns/app-shells.tsx` now renders `MarketplaceFacetRail` as a `section` with subtle bottom separation instead of `Card variant="feature"`.
- After rebasing onto `origin/main` at `897243b5`, the flattened section surface was reconciled with the newer searchable facet option behavior so searchable rails keep their search input, scrollable option list, selected-outside-search preservation, and empty search message.
- The surrounding `SearchResultsLayout` and `Sidebar` remain unchanged, so desktop still has one sticky, scrollable filter surface.
- Mobile filter presentation stays on the existing `MarketplaceFacetChoiceGroup` and bottom-sheet path.
- No Discovery behavior, Catalog projection, API contract, domain event, or localization term changed.

## Verification Evidence

- Pre-rebase `pnpm run test:design-system`: passed, 2 files passed, 91 tests passed.
- Pre-rebase `pnpm --filter @chase-sets/discovery run test -- features/search/ui/search-page.test.tsx`: passed, 1 file passed, 13 tests passed.
- Post-rebase `pnpm run test:design-system`: passed, 2 files passed, 98 tests passed.
- Post-rebase `pnpm --filter @chase-sets/discovery run test -- features/search/ui/search-page.test.tsx`: passed, 1 file passed, 14 tests passed.
- Post-rebase `pnpm --filter @chase-sets/design-system run typecheck`: passed.
- `pnpm --filter @chase-sets/discovery run typecheck`: not available; Discovery has no package-local `typecheck` script.
- Pre-rebase `pnpm run verify:typecheck`: passed.
- Browser desktop check at `http://localhost:11303/search?category=singles`: sidebar showed one outer filter surface, sectioned facet groups, and DOM count `nestedFeatureCards=0`, `facetSections=2`.
- Browser mobile check at `390x844`: desktop sidebar hidden and mobile `Open filters` control visible.
- Visual screenshots were captured locally under `.codex/filter-rail-desktop.png` and `.codex/filter-rail-mobile.png` for this worktree.

## Documentation To Promote

- No durable docs are required unless implementation changes the canonical marketplace filter contract beyond the visual surface treatment. If needed, promote a design-system pattern note under `packages/design-system/`.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
