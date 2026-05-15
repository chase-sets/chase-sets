# Mobile Search Filter UX

## Intent

Improve the mobile marketplace search filter experience after dynamic Discovery filters shipped. The current mobile behavior exposes every top-ranked facet as stacked horizontal strips above results. That makes dynamic filters reachable, but it pushes the first result down the page and forces repeated horizontal scanning. The follow-up should keep filters best-in-class on mobile: discoverable, reversible, summarized, accessible, and fast to apply without hiding the result context.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-mobile-search-filters`
- Branch: `codex/mobile-search-filter-ux`
- Base: `origin/main` at `ecb7bd80`, which includes PR #99 dynamic filters and PR #102 replay bump.
- Dependency setup: complete via `pnpm run deps:install`.
- Sandbox id: `66dab2d5`.
- Sandbox status: healthy via `pnpm run sandbox:doctor`.
- Sandbox URLs:
  - Dev portal: `http://localhost:9250`
  - Marketplace: `http://localhost:9253`
  - Platform API: `http://localhost:9262`
- Setup caveats:
  - `pnpm run deps:install` reports existing cyclic workspace dependencies involving Checkout, Ordering, marketplace seed testing, and Discovery; install completed successfully.

## Owning Contexts

- Discovery owns the Discovery Query, Filter State, Facet presentation behavior, search route state, applied chips, result summary, and marketplace search UI.
- Catalog remains upstream for Field, Dimension, Option, Blueprint, Category, and Product identity.
- Design System owns reusable marketplace filtering patterns and primitives. Mobile filter UX should be represented as canonical design-system components before Discovery composes them.
- Deployables remain thin composition roots and should not own filter behavior or mobile filter state.

## Repo Evidence

- `bounded-contexts/README.md` says Discovery may project browse-oriented read models from upstream contexts and owns search/browse views.
- `bounded-contexts/discovery/README.md` lists search query behavior, filter state, and facet presentation as Discovery-owned.
- `bounded-contexts/discovery/GLOSSARY.md` defines Facet, Filter, Filter State, Discovery Query, Result Set, and Search Result.
- `bounded-contexts/discovery/docs/dynamic-search-filters.md` says category is first, dynamic facets are result-aware, the UI shows top five dynamic groups, and broader value discovery should use a canonical design-system expand or search interaction.
- `packages/design-system/MARKETPLACE_SYSTEM.md` says mobile filters should be drawer-friendly, reversible, summarized as chips, and use 44px touch targets.
- `packages/design-system/PROGRESSIVE_DISCLOSURE.md` says advanced search filters are a good disclosure candidate, but current effects should stay visible in the summary.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` currently renders mobile category and dynamic facets as inline `MarketplaceFacetStrip` sections before results.
- `packages/design-system/src/patterns/app-shells.tsx` currently provides `MarketplaceFacetRail` and `MarketplaceFacetStrip`, but no canonical mobile filter summary/drawer composition.
- `packages/design-system/src/components/ui/marketplace.tsx` has a minimal `MarketplaceFilterDrawer`, but it lacks trigger, summary, close, apply/clear affordances, selected-count communication, and route-composition ergonomics.

## Resolved Decisions

- Dynamic filter behavior remains Discovery-owned.
- The design-system should own the reusable mobile filtering shell/pattern instead of Discovery adding local drawer styling.
- The current stacked facet strips are not sufficient for best-in-class mobile behavior because they create a long pre-results control surface and depend on horizontal scrolling for every facet group.
- Selected filters must remain visible as reversible applied chips outside any drawer.
- Category remains a primary browse facet, but on mobile it should participate in the same filter editing surface unless a small quick-access category strip is retained without pushing results too far down.
- Canonical mobile filter interaction: bottom sheet. The sheet should be opened from a compact filter control above results, keep active state summarized outside the sheet, group choices vertically inside the sheet, and provide clear/done footer actions.

## Open Questions

- None.

## Recommended Direction

Use a design-system mobile filter bar plus bottom-sheet drawer:

- Visible above results: a compact filter trigger with active count, result summary, and applied chips.
- Drawer contents: category, language, and ranked dynamic facets grouped vertically with 44px controls.
- Footer: clear all and show results/done actions.
- Optional fast path: show only the active/highest-priority quick chips outside the drawer when they do not push results down.

This follows marketplace design-system guidance: filters are drawer-friendly, reversible, and summarized as chips. It also keeps the first result close to the top while still letting power users refine quickly.

## Implementation Checklist

- [x] Add or evolve canonical design-system mobile filter components/patterns for a trigger, summary, drawer, grouped facet choices, footer actions, and reversible state.
- [x] Update Discovery search UI to compose the design-system mobile filter pattern instead of rendering all dynamic facets inline before results.
- [x] Preserve URL-backed Filter State and existing field/dimension/category/language/sort behavior.
- [x] Keep applied chips visible outside the drawer and reversible.
- [x] Ensure the mobile drawer has accessible labels, close behavior, keyboard/focus-safe controls, and 44px touch targets.
- [x] Add focused design-system tests for the mobile filter pattern.
- [x] Add Discovery UI tests for mobile filter trigger/count, drawer content, reversible chips, and dynamic filter selection.
- [x] Update Discovery dynamic filter docs with the mobile presentation policy.
- [x] Run targeted tests, structure/localization checks, typecheck, relevant build/test commands, and desktop/mobile visual checks.

## Documentation To Promote

- Updated `bounded-contexts/discovery/docs/dynamic-search-filters.md` with the mobile filter presentation policy.
- Design-system usage is covered by focused component tests for the new marketplace mobile filter bar, bottom sheet, and choice-group pattern.

## Verification

- `pnpm --filter @chase-sets/design-system test`
- `pnpm --filter @chase-sets/discovery test`
- `pnpm --filter @chase-sets/design-system typecheck`
- `pnpm run check:localization`
- `pnpm run check:structure`
- `pnpm run typecheck`
- `pnpm run test:fast`
- `pnpm run build`
- Local browser visual checks:
  - Mobile 390x844 at `http://localhost:9253/search?q=bulbasaur&field.fld_seed_card_number=44%2F102`: compact filter bar is above results, applied chips stay reversible, and the bottom sheet opens with Category, Language, and Card Number facet groups.
  - Desktop 1366x900 at the same URL: the desktop facet rail remains present and the mobile Open filters trigger is absent.

## Goal Completion Criteria

The implementation goal must:

- [x] Implement mobile search filter UX in this worktree on branch `codex/mobile-search-filter-ux`.
- [x] Keep the design-system as the canonical home for reusable mobile filter components or patterns.
- [x] Preserve Discovery ownership of filter behavior and URL-backed Filter State.
- [x] Promote durable docs for mobile facet presentation.
- [x] Retain this `.codex/plans/20260515-mobile-search-filter-ux.md` file with the implementation.
- [x] Verify automated checks, including focused Discovery/design-system tests, structure/localization checks, typecheck, and practical broader test/build commands.
- [x] Run desktop and mobile visual verification of marketplace search.
- [ ] Submit a PR, ensure CI passes, merge it, verify staging deploy behavior, and keep the plan committed.
