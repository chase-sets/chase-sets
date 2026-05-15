# Dynamic Search Filters

## Intent

Users need a best-in-class marketplace search experience that gets them to the right catalog item in the fewest clicks. Search currently filters by category, language, tag, blueprint, and status at the API/query layer, while the visible search UI mainly exposes categories and language. The implementation should add dynamic, result-aware filters for Catalog-owned Fields and Dimensions while keeping Discovery as the behavior owner for search queries, facet presentation, ranking, and filter state.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-dynamic-search-filters`
- Branch: `codex/dynamic-search-filters`
- Created from source repo `main` at `8cc4f1e6` because no base branch was named.
- Dependency setup: complete via `pnpm run deps:install`.
- Sandbox id: `070504cc`.
- Sandbox status: healthy via `pnpm run sandbox:doctor`.
- Sandbox URLs:
  - Dev portal: `http://localhost:7200`
  - Marketplace: `http://localhost:7203`
  - Platform API: `http://localhost:7212`
- Setup caveats:
  - Source repo `main` was behind `origin/main` by 25 commits when the worktree was created.
  - `pnpm run deps:install` reported existing cyclic workspace dependencies involving Checkout, Ordering, marketplace seed testing, and Discovery; install still completed successfully.

## Owning Contexts

- Discovery owns the search behavior, Discovery Query, Search Index, Result Set, Facet, Filter, Filter State, search routes, browse-oriented read models, API response shape, and marketplace search UI.
- Catalog owns canonical Catalog Items, Fields, Dimensions, Options, Blueprints, Categories, Product identity, and the meaning of `field.behavior.filterable`.
- Design System owns reusable UI patterns and components. Search UI changes should compose existing design-system controls or add canonical design-system components before use, with no app-local styling overrides.

## Resolved Decisions

- Dynamic filter behavior belongs in `bounded-contexts/discovery/features/search/` because Discovery already owns search query behavior, filter state, facet presentation, search index rebuilds, and the marketplace search route.
- Catalog remains upstream truth. Discovery should project Catalog facts from published integration events into search-owned read models; it must not import Catalog internals or decide Product validity.
- `Field`, `Dimension`, and `Option` remain Catalog terms. Discovery UI may use simpler labels, but API and docs should keep the formal terms where the model boundary matters.
- Field facets should only be eligible when Catalog marks a Field as `filterable`; this follows existing Catalog field behavior flags and avoids exposing authoring-only data.
- Dimension facets should come from Blueprint/Product Schema facts, using Catalog `dimension_id` and `option_id` as stable filter values. Labels can be denormalized into Discovery for presentation.
- Search facets should be result-aware: facet counts are computed from the active Discovery Query with the candidate facet's own selection excluded, so users can see useful next refinements instead of dead ends.
- Category should stay a primary facet because it is already a proven public route and canonical browse entry point. Dynamic filters should enhance, not replace, category browse.
- Dynamic facet priority is resolved: use a deterministic Discovery ranking policy with category first, then dimensions and filterable fields ranked by active-result coverage and distinct-value usefulness. Show the top five dynamic facet groups by default, cap each group to the top eight values, and add an expand/search interaction later through the design system if broader value discovery is needed.
- API changes should keep deployables thin. The existing Discovery request API and route loader should pass dynamic filter params through to Discovery-owned search services.
- Product code has not been changed during planning.

## Repo Evidence

- `bounded-contexts/README.md` says Discovery depends on Catalog for canonical item, category, blueprint, and field facts used to build browse/search views, and Discovery may project browse-oriented read models without owning upstream truth.
- `bounded-contexts/discovery/README.md` explicitly lists search query behavior, search relevance and sort behavior, browse-oriented read models, filter state, facet presentation, and search index rebuild workflows as Discovery-owned.
- `bounded-contexts/catalog/README.md` says Catalog owns Fields, Dimensions, Options, Blueprints, Categories, Product identity, and does not own search and discovery filtering behavior.
- `bounded-contexts/discovery/features/search/read-model/queries.ts` currently supports `category`, `tag`, `blueprintId`, `language`, `status`, search text, sort, offset, cursor, and total count.
- `bounded-contexts/discovery/features/search/read-model/projection.ts` currently stores `field_values` in `discovery_search_catalog_items` and flattens them into `field_values_text`, but does not preserve field names, filterability, or per-field filter values in `discovery_search_items`.
- `bounded-contexts/discovery/features/search/read-model/schema.ts` has GIN indexes for tags and category JSON arrays, but no filter-value index for fields or dimensions.
- `bounded-contexts/discovery/features/item-detail/read-model/projection.ts` already projects field definitions, dimension definitions, option labels, blueprint dimension rules, and product schemas for detail pages; search can reuse the same upstream facts in its own slice instead of crossing into item-detail runtime state.
- `bounded-contexts/catalog/features/fields/read-model/schema.ts` and field tests establish `filterable`, `searchable`, and `sortable` as Catalog-authored field behavior flags.
- `bounded-contexts/discovery/tests/acceptance/marketplace-search.test.ts` already exercises Catalog-to-Discovery projection, search, category filtering, language filtering, and product schema projection; it is the right acceptance-test home for dynamic filters.
- `packages/design-system/src/patterns/app-shells.tsx` provides `SearchResultsLayout` and `MarketplaceFacetRail`; `packages/design-system/src/components/ui/marketplace.tsx` provides `SearchControlBar` and `AppliedFilterChips`.

## Open Questions

- None for the initial implementation. Revisit manual merchandising only after dynamic usefulness ranking proves insufficient with real marketplace traffic.

## Implementation Checklist

- [x] Extend the Discovery search read-model schema with search-owned facet metadata and normalized facet values for eligible Catalog fields and blueprint dimensions/options.
- [x] Project Catalog field definitions, field configuration changes, dimension definitions, option revisions, and blueprint dimension rules into the Discovery search slice.
- [x] Preserve field values as structured filter values, not only flattened search text.
- [x] Add search query parameters for field and dimension filters with stable URL encoding that uses `field_id` and `dimension_id`/`option_id`.
- [x] Apply dynamic filters in `searchDiscoveryItems` with safe structured SQL and existing pagination/count behavior.
- [x] Return a `facets` payload with dynamic field and dimension facet groups, ordered by the resolved priority policy. Category remains supplied by the existing Discovery category API and rendered first in the rail.
- [x] Update Discovery client contracts, API route parsing, request client use, route loader state, applied filter chips, and UI controls.
- [x] Keep UI on design-system primitives/patterns; `MarketplaceFacetRail` now supports multi-selected values and `MarketplaceFacetStrip` provides compact mobile facet controls.
- [x] Add acceptance coverage for filtering by a filterable field value and by a dimension option, including facet counts. This DB-backed file is present but skips locally when `TEST_DATABASE_URL` is absent.
- [x] Add focused unit/component tests for applied chips, mobile category preservation, and dynamic filter rendering.
- [x] Run targeted tests, `pnpm run typecheck`, `pnpm run test:fast`, `pnpm run build`, and seeded desktop/mobile visual checks against the marketplace route.

## Documentation To Promote

- Added `bounded-contexts/discovery/docs/dynamic-search-filters.md` to preserve the durable facet-ranking and URL contract.
- Update `bounded-contexts/discovery/GLOSSARY.md` if Facet or Filter definitions need examples for Field facets and Dimension facets.
- Added `docs/README.md` owner-owned documentation entry for Discovery Dynamic Search Filters.

## Goal Completion Criteria

The implementation goal must:

- [x] Implement dynamic field and dimension filters in the feature worktree at `D:\Users\ToddS\Source\Repos\chase-sets-20260515-dynamic-search-filters` on branch `codex/dynamic-search-filters`.
- [x] Promote durable Discovery documentation for the final facet-ranking and URL contract if the policy remains non-trivial.
- [x] Retain this `.codex/plans/20260515-dynamic-search-filters.md` file with the implementation for reviewer context.
- [x] Verify automated checks, including targeted Discovery search tests, typecheck, and the relevant broader test command that is practical for the final patch size.
- [x] Run desktop visual verification of the marketplace search route after frontend changes.
- [x] Run mobile visual verification of the marketplace search route after frontend changes. Browser verification at `443x958` confirmed the applied `Card Number: 4/102` chip, top-ranked dynamic facet strips, selected `4/102 (1)` state, the narrowed Charizard result card, and bottom navigation without layout overlap.
- [x] Submit a draft PR and ensure the first CI run passes.
- [x] Mark the PR ready after the mobile follow-up commit is pushed and CI passes again.
- [ ] Merge the PR, verify staging deploy behavior, and keep the plan committed.
