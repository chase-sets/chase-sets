# Dimension Filter Detail Selection

## Intent

When a buyer filters search results by Catalog Dimensions, opening a Search Result should carry those selected Dimension Options into the Discovery Detail Page so the matching Product is already selected and the buyer can immediately inspect listings, add to cart, buy, or make an offer.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-dimension-filter-detail-selection`
- Branch: `codex/dimension-filter-detail-selection`
- Base: `origin/main` at `7da38ab2` (`Improve mobile search filter UX (#104)`) because the source checkout was behind the remote and this feature depends on the merged mobile filter work.
- Sandbox id: `17d3014b`
- Marketplace: `http://localhost:10953`
- Platform API: `http://localhost:10962`
- Dependency setup: `pnpm run deps:install` passed with existing cyclic workspace dependency warnings.
- Sandbox setup: `pnpm run sandbox:doctor` passed.

## Owning Contexts

- Discovery owns Search Query behavior, Filter State, Search Result presentation, Detail Page behavior, and Product Alert creation from detail selection.
- Catalog owns the meaning and validity of Dimensions, Options, selected_options, and Product identity.
- Marketplace owns Listings and Offers once Discovery resolves or carries a Product selection.
- Checkout owns cart and checkout intent after item detail submits the selected product.

## Resolved Decisions

- Behavior owner: Discovery. The handoff is browse/detail behavior between Discovery Search and Discovery Item Detail.
- Handoff surface: Search Result item links should include selected Dimension filters as query parameters on `/items/:slug`. This keeps the selection shareable, browser-native, and aligned with existing URL-backed filter state.
- Field filters must not preselect Product Options because Catalog Fields describe Catalog Items and do not create Products.
- The Detail Page should validate incoming Dimension Option selections against the projected Product Schema before applying them.
- Canonical item detail URLs remain query-free; selection query parameters are stateful UI inputs, not canonical identity.
- Ambiguous Dimension filters are not guessed: if Search has multiple selected Options for the same Dimension, the Detail Page leaves that Dimension unset. This keeps multi-select search flexible while avoiding a surprising single Product selection.

## Open Questions

- None.

## Implementation Checklist

- [x] Add a Discovery-owned helper to derive item detail selection query parameters from active Dimension filters.
- [x] Update Search Result card and primary action links to preserve only Dimension filters relevant to Product selection.
- [x] Update Item Detail route/UI contracts to accept initial selected options from the URL.
- [x] Normalize incoming selections against the Product Schema and active dimension rules.
- [x] Ensure selected options immediately shape visible listings/offers and commerce forms.
- [x] Add focused unit tests for Search Result links and Detail Page initial selection.
- [x] Run targeted Discovery tests, localization/structure checks, typecheck, build, and browser checks for desktop/mobile.

## Documentation To Promote

- [x] Update `bounded-contexts/discovery/docs/dynamic-search-filters.md` with Dimension filter handoff behavior.
- [x] Update this plan as decisions and verification results settle.

## Verification

- `pnpm --filter @chase-sets/discovery test` passed after implementation and after the ambiguity fallback fix.
- `pnpm run typecheck` passed.
- `pnpm run check:localization` passed.
- `pnpm run check:structure` passed.
- `pnpm run test:fast` passed.
- `pnpm run build` passed.
- Browser smoke on `http://localhost:10953` passed for desktop Search-to-Detail selection handoff.
- Browser smoke on `http://localhost:10953` passed for mobile Detail Page with `Form: Raw` and `Condition: Excellent` selected, `5 of 5 listings` visible, and mobile Buy / Make Offer actions available.
- The implementation goal could not be created because this thread already has a completed prior goal; this plan retains the intended completion criteria.

## Goal Completion Criteria

- The implementation is committed with this retained plan.
- Dimension filters selected in Search produce item detail URLs that preselect the same valid Product Options.
- Ambiguous or invalid Dimension selections do not corrupt Product selection or Product identity.
- Field filters continue to refine Search only and do not affect Detail Page Product selection.
- Automated checks pass: targeted Discovery tests, typecheck, structure, localization, fast tests, and build.
- Browser verification covers desktop and mobile Search-to-Detail flow.
- PR is submitted, CI passes, PR is merged, and production deploy is verified.
