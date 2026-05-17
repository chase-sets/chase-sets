# Search Filtering Guidance

## Intent

Update the durable Discovery and design-system guidance for dynamic marketplace search filters so the implementation path avoids nested scroll regions, keeps selected filters stable, and gives buyers fast, reversible narrowing on desktop and mobile.

This is a documentation and design-system guidance change only. Product/runtime code changes should follow this plan in a separate implementation pass.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-search-filtering-guidance`
- Branch: `codex/search-filtering-guidance`
- Sandbox id: `c6b4f9d0`
- Dependency setup status: `pnpm run sandbox:env` installed workspace dependencies as part of sandbox environment resolution on 2026-05-17.
- pnpm store path: default embedded worktree store through `scripts/worktree-deps.mjs`; no custom `CHASE_SETS_PNPM_STORE_DIR` set.
- Setup blockers: none known.

## Owning Contexts

- Discovery owns search query behavior, search relevance and sort behavior, browse-oriented read models, Filter State, Facets, filter presentation, facet counts, and the search/item-detail handoff.
- Catalog owns canonical Catalog Item, Field, Dimension, Option, Blueprint, and Product identity. Discovery may denormalize these facts for browse and search, but labels and display order are presentation only.
- The design system owns reusable marketplace filter surfaces, responsive panel taxonomy, accessibility rules, scroll behavior, and reusable facet UI components.
- Deployables remain thin composition roots and must not own search-filter behavior or introduce route-local panel primitives.

## Resolved Decisions

- Use usefulness ranking for facet group order, not raw fewest-options-first ordering. Usefulness considers active-result coverage, decision importance, useful distinct-value count, selected state, stable labels, and buyer workflow value.
- Keep selected Filters visible and reversible even when refreshed facets would otherwise exclude them. Selected values are part of Filter State and must not disappear from active chips or their owning group.
- Refresh Result Set, facet group availability, facet counts, and option ordering from the active Discovery Query whenever Filter State changes.
- Compute counts for each candidate facet group by excluding that group's own current selection while respecting all other active Filters. Existing read-model queries already use this rule for field and dimension value counts.
- Hide unavailable zero-count options by default, except selected options must remain visible. A future expert-only "show unavailable" affordance can be added only if a workflow needs full taxonomy comparison.
- Avoid nested scroll ownership. Desktop search may use one persistent filter rail scroll area inside the page layout, but individual facet groups must not create their own independent scrollbars. Mobile filter sheets may scroll as a single body with sticky header/footer, but facet groups should not create scrollable subregions.
- Long option lists use progressive disclosure and option search instead of tiny scroll regions. Show a concise default set, then `Show more` / `Show less` and searchable option narrowing for high-cardinality facets.
- Desktop keeps the full results context visible with a persistent left filter rail, active chips in the search control area, and single-scroll filter content. Mobile uses a filter bar plus bottom sheet for ordinary filter work; if a single facet becomes dense enough to need deep search, promote that facet to a focused sheet section or full page instead of nesting scroll containers.
- Discovery search and item detail should keep Product-defining Dimension selections aligned so buyers who narrow by product options land on item detail with matching product context. Field filters remain result-set constraints and do not define Product identity.

## Open Questions

- None blocking for this documentation pass.

## Implementation Checklist

- [x] Update `packages/design-system/MARKETPLACE_SYSTEM.md` with the canonical marketplace search/filter pattern.
- [x] Update `packages/design-system/PANEL_INTERACTIONS.md` with a specific filter scroll-ownership rule for desktop and mobile.
- [x] Update `bounded-contexts/discovery/docs/dynamic-search-filters.md` to replace the independent desktop filter-rail scrollbar language with single-scroll, progressive-disclosure, selected-filter stability, and high-cardinality option search guidance.
- [x] Update the plan after verification.
- Leave product/runtime code, schemas, tests, and UI components untouched in this pass.

## Verification

- `git diff --check`
- `pnpm run sandbox:doctor`
- `pnpm run test:design-system`

## Documentation To Promote

- `packages/design-system/MARKETPLACE_SYSTEM.md`
- `packages/design-system/PANEL_INTERACTIONS.md`
- `bounded-contexts/discovery/docs/dynamic-search-filters.md`
- `docs/README.md` already links to these owner-owned docs; no docs-map change is expected unless a new durable doc is added.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
