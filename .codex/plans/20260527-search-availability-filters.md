# Search Availability Filters

## Intent

Users need to narrow search results to items with marketplace activity, especially after selecting product dimensions such as condition, so they can find actionable supply or demand quickly.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260527-search-availability-filters`
- Branch: `codex/search-availability-filters`
- Sandbox id: `589d37bc`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: default `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none

## Owning Contexts

- Discovery owns search query behavior, filter state, browse read models, facet presentation, and marketplace-branded public search routes.
- Marketplace owns Listing, Offer, Seller Listing Availability, and the lifecycle facts projected into Discovery.
- Catalog owns dimensions, options, product identity, and selected option shape.

## Resolved Decisions

- Ownership: Implement the search-result filter in Discovery, not Marketplace. Discovery already owns search and may project Marketplace facts for browse behavior; Marketplace remains the source of Listing and Offer truth.
- Language: Use user-facing natural language: `Listings`, `Offers`, and `Listings or offers`. Use `marketActivity` as the Discovery Query/API parameter because the filter is result-shaping browse behavior over projected marketplace facts, not a new Marketplace lifecycle concept.
- Invariants: Listings count only active listings from accounts whose Seller Listing Availability is `available`. Offers count only `submitted` offer demand; accepted offers have left public marketplace-wide demand.
- Product-option matching: When dimension filters are present, marketplace activity must match those selected options by `selected_options`, grouped as OR within the same dimension and AND across different dimensions. Without this, `condition=Near Mint` plus `Listings` could show an item that only has a damaged listing, which does not satisfy the user intent.
- Read models: Do not add new tables for this first pass. `discovery_market_listings` and `discovery_offer_demand_matches` already carry `catalog_catalog_item_id`, status, account availability, and `selected_options`, which is enough for a query-time filter and focused indexes already exist for item/status lookups.
- API: Add optional `marketActivity=listings|offers|any` to `/api/marketplace/items` and bulk-cart preview query parsing. Unknown values should be ignored as absent to keep shared links resilient.
- UI: Add a top-level filter rail group and mobile filter group near category/language filters, keep applied chips reversible, and preserve existing dimension chips and item-detail URL behavior.
- Realtime: Existing realtime patches can continue updating visible result cards. A future refinement may refresh result-set membership live when activity changes affect a selected `marketActivity` filter; the first pass should preserve the existing reload-on-sync fallback behavior.
- Operations: No new durable runtime process, projection subscription, or cross-context event is required.

## Evidence

- `bounded-contexts/discovery/README.md` says Discovery owns search query behavior, browse read models, filter state, and facet presentation, and may consume Marketplace listing signals for commercial browse state.
- `bounded-contexts/marketplace/README.md` and `GLOSSARY.md` say Listings and Offers are Marketplace-owned, product-scoped, and reference `catalogItemId`, `productId`, and normalized `selectedOptions`.
- `bounded-contexts/discovery/context.json` already subscribes `discovery-market-projection` to Marketplace listing, seller availability, and offer events.
- `bounded-contexts/discovery/features/search/read-model/queries.ts` already joins projected listings for `market_summary`; the same read model can answer activity filters.
- `packages/design-system/MARKETPLACE_SYSTEM.md` says search filters should expose result-shaping facets, dynamic filtering should update counts and availability, and unavailable zero-count options should not clutter marketplace filters.

## Open Questions

- None blocking.

## Implementation Checklist

- [x] Add market activity query parsing, typing, and SQL filtering in Discovery search read-models.
- [x] Make listing/offer matching product-option-aware when dimension filters are selected.
- [x] Add contracts and route state for `marketActivity`.
- [x] Add desktop and mobile filter controls plus applied chips.
- [x] Add focused query and UI tests.
- [x] Install dependencies and run sandbox doctor.
- [x] Run focused verification.

## Verification

- `pnpm run sandbox:doctor`
- `pnpm --filter @chase-sets/discovery exec vitest run --config ./tests/vitest.config.mjs features/search/read-model/queries.test.ts features/search/ui/search-page.test.tsx`
- `pnpm --filter @chase-sets/discovery run test`
- `pnpm run check:localization`
- `pnpm run verify:typecheck`
- `pnpm run check:structure` passed with existing single-slice support warnings outside this change.
- `pnpm run verify:metadata`

## Documentation To Promote

- None expected. The implementation uses existing context glossary terms (`Filter`, `Discovery Query`, `Listing`, `Offer`) and does not introduce a durable cross-context concept.

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
