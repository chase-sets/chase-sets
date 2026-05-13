# Keep Desktop Category Sidebar

## Intent

Selecting a browse category should not make category navigation disappear on desktop. The current focused-results state leaves category alternatives below the results, which makes the path back to broader or neighboring categories hard to discover. The implementation should keep filtering clear, reversible, and close to the result set without moving category behavior out of the Discovery bounded context.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-keep-desktop-category-sidebar`
- Branch: `codex/keep-desktop-category-sidebar`
- Created from: source repo `main` at `4f492f63`
- Sandbox id: `ee8c1281`
- Dependency setup: `node ./scripts/worktree-deps.mjs install` completed.
- Sandbox setup: `pnpm run sandbox:doctor` completed.
- Sandbox ports: marketplace `http://localhost:10453`, platform API `http://localhost:10462`, dev portal `http://localhost:10450`
- Setup caveat: initial setup warned because the desktop shell exposed Node `v26.1.0`; after rebasing onto current `main`, rerunning `node ./scripts/worktree-deps.mjs install` used Node `v24.14.0` and reported the worktree ready.

## Owning Contexts

- Discovery owns the behavior change. Its README says it owns browse, search, browse-oriented read models, filter state, and facet presentation.
- Catalog owns category truth and category membership. Catalog README and glossary say Category is catalog authoring/grouping metadata and Catalog does not own search or faceted filtering behavior.
- The design system owns the reusable UI patterns used to express the behavior. Marketplace search must stay backed by design-system primitives rather than deployable overrides.
- Marketplace is not the owner for this change. Marketplace owns listing and offer workflows before an order exists, while this issue is a Discovery Query / Filter State / Facet presentation problem.

## Resolved Decisions

- Use Discovery terms: `Discovery Query`, `Result Set`, `Facet`, `Filter`, `Filter State`, and `Search Result`.
- Treat "category sidebar" as a desktop presentation of the existing Category Facet rather than a new domain concept.
- Do not introduce new product-code behavior during planning. Implementation will happen after the product decision below is resolved.
- Keep deployables thin. Relevant implementation should stay in `bounded-contexts/discovery/features/search/ui/search-page.tsx` and, if needed, design-system pattern components under `packages/design-system/src`.
- Focused desktop result pages should keep the category facet rail visible in the left column. Applied filter chips remain in the control bar so selected filters are still summarized and reversible.
- No domain events are expected because this is read/presentation behavior only.
- No read-model or API changes are expected because the route already receives categories and search data needed to render the facet.
- Mobile should remain compact and reversible. If implementation changes mobile category filtering, it should use design-system filter/drawer/pill patterns rather than route-local custom UI.

## Repo Evidence

- `bounded-contexts/discovery/context.json` declares the `search` and `categories` slices and mounts `/api/marketplace` search/category routes.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` computes `hasFocusedResults` from search, category, language, sort, and page.
- `SearchPage` passes `filters={hasFocusedResults ? null : <MarketplaceFacetRail ... />}` into `SearchResultsLayout`, which hides the desktop left rail whenever a category is selected.
- The same file renders category buttons after the results grid only in focused-results state, so desktop users must scan below results to change categories.
- `packages/design-system/src/patterns/app-shells.tsx` already provides `SearchResultsLayout` with a desktop left column when `filters` is present.
- `packages/design-system/src/patterns/app-shells.tsx` already provides `MarketplaceFacetRail`, whose default copy is `Browse Categories`, `Narrow the marketplace by category and current catalog depth.`, and `All Categories`.
- `packages/design-system/MARKETPLACE_SYSTEM.md` says search results should stay calm and task-first, filters should be reversible and summarized as chips on mobile, and desktop should prefer sticky sidebars or inline CTAs that do not cover content.

## Open Questions

- None.

## Implementation Checklist

- Done: keep the Discovery-owned Category Facet available in focused desktop result states by always passing `MarketplaceFacetRail` to `SearchResultsLayout`.
- Done: preserve the landing/browse hero behavior when there are no focused filters.
- Done: preserve applied filter chips and clear-all behavior.
- Done: remove the post-results category button row and replace it with a mobile-only category switcher directly below focused search controls.
- Done: keep mobile category changes obvious and reversible with a top-of-results horizontal category switcher built from design-system buttons.
- Done: add focused UI tests for selected category, visible category facet, mobile switcher placement, and applied chip removal.
- Done: run targeted Discovery/design-system tests.
- Done: start the marketplace app and visually verify desktop and mobile category-selection flows.

## Implementation Notes

- `bounded-contexts/discovery/features/search/ui/search-page.tsx` now builds one Category Facet model for desktop and one compact focused-results category action strip for mobile.
- Focused result grids now hold at two columns until `2xl` so returning the desktop rail does not squeeze listing cards.
- `packages/design-system/src/patterns/app-shells.tsx` makes `SearchResultsLayout` content shrinkable with `min-w-0` and keeps the desktop filter column sticky.
- `contracts/localization/locales/en.ts` adds the `Browse categories` label for the mobile category switcher.
- No durable design-system documentation promotion was needed because this uses the existing `SearchResultsLayout` and `MarketplaceFacetRail` patterns rather than changing the canonical marketplace filter pattern.

## Verification Evidence

- `pnpm --filter @chase-sets/discovery run test`: passed before rebase with 13 files passed, 1 skipped, 59 tests passed, 3 skipped; passed after rebasing onto `origin/main` with 13 files passed, 1 skipped, 61 tests passed, 3 skipped.
- `pnpm --filter @chase-sets/app-marketplace-web run test -- app/routes/search.test.tsx`: passed after addressing the CI duplicate-category-control query, 1 file passed, 9 tests passed.
- `pnpm --filter @chase-sets/app-marketplace-web run test`: passed after addressing the CI failure, 19 files passed, 78 tests passed.
- `pnpm run test:design-system`: passed, 2 files passed, 79 tests passed.
- `pnpm run check:localization`: passed before rebase for 374 source files; passed after rebase for 373 source files.
- `pnpm run verify:typecheck`: passed.
- `pnpm run verify:build`: passed before rebasing onto `origin/main`; post-rebase rerun was not performed because sandbox escalation for that build command was not approved.
- Browser desktop visual checks against `http://localhost:10453`: category selection keeps the rail visible, category switching highlights the new category and updates the URL/result summary, clear-all returns to `/search`, search/sort/language chips remain visible, no-results recovery keeps the rail and recovery actions, and saved-search placement remains below focused results.
- Browser mobile visual checks with a `390x844` viewport: desktop rail is hidden, the focused category switcher appears above results/recovery, category switching updates the selected chip and summary, no-results recovery remains reachable, and saved-search/recovery actions stay below the filter controls.

## Documentation To Promote

- No durable docs are required yet. If implementation changes the canonical marketplace search/filter pattern, document it in `packages/design-system/MARKETPLACE_SYSTEM.md` or the design-system README as a pattern note.

## Goal Completion Criteria

The later implementation goal must:

- Reference this worktree path, branch, and plan path.
- Implement the accepted category-filter UX in the feature worktree.
- Promote any durable design-system/search-filter documentation that becomes necessary.
- Verify automated tests for affected Discovery/design-system behavior.
- Perform desktop and mobile visual checks of category selection, category switching, clear-all, search, sort, language filter, no-results recovery, and saved-search prompt placement.
- Submit a PR from `codex/keep-desktop-category-sidebar`.
- Reach passing CI.
- Merge the PR.
- Verify the staging deploy after merge.
- Retain this `.codex/plans/20260513-keep-desktop-category-sidebar.md` file with the implementation.
