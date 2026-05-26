# Catalog Card Layout

## Intent

Improve the Discovery search product-card layout after the crisp-image rollout made card imagery clear but exposed scan-density and action-hierarchy issues in staging.

The follow-up PR should address these findings:

- P1: Three-column search cards are too narrow for the current side-by-side image and content layout.
- P1: Product-card actions compete with each other and do not expose one obvious primary action.
- P2: `Supply wanted` / `Available now` badges collide with product imagery.
- P2: Repeated metadata such as `English` and `Pokemon Card Single` adds noise before the product name.
- P2: Card height and stacked controls create too much vertical drag for browse scanning.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260526-catalog-card-layout`
- Branch: `codex/catalog-card-layout`
- Base: freshly fetched `origin/main` at `8426dd22 Reset stale staging root domain attachment (#301)`
- Sandbox id: `407ae9ce`
- Dependency setup: `pnpm run deps:install` completed successfully with shared pnpm store.
- Sandbox doctor: `pnpm run sandbox:doctor` completed successfully.
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none.

## Owning Contexts

- Discovery owns browse, search, Search Results, filter state, and item-detail presentation models.
- Marketplace owns Listing and Offer lifecycle facts consumed by Discovery, but this card layout work must not move Marketplace behavior into Discovery.
- Catalog remains the source of canonical item/product facts and product image asset roles.
- The design system remains the canonical home for `ListingCard` structure, marketplace card hierarchy, and product media presentation.

## Repo Evidence

- `bounded-contexts/discovery/README.md` says Discovery owns browse, search, detail experience, Search Result presentation, filters, and read models.
- `bounded-contexts/marketplace/README.md` says Marketplace owns listing/offer workflows and explicitly does not own browse, search, or item detail discovery experiences.
- `packages/design-system/MARKETPLACE_SYSTEM.md` says `ListingCard` must preserve one primary action, with save/compare/watchlist as secondary affordances that do not compete visually.
- `packages/design-system/MARKETPLACE_SYSTEM.md` says search result cards may use compact Buy / Sell / Watch actions while scanning, but the primary action should target the selected/default Product and secondary menu choices can reveal additional immediate listing/offer actions.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` rendered search results through `ListingCard` with `imageSlot="compact-product"`, a three-column grid at wide widths, metadata in `condition` and `availability`, promotion badges, and Buy / Sell / Watch links inside `primaryAction`.
- `packages/design-system/src/components/ui/marketplace.tsx` placed promotion badges over the media area and used a side-by-side image/content layout for media-backed `ListingCard` instances on small-plus breakpoints.

## Resolved Decisions

- Keep ownership in Discovery search and the design system. Do not create deployable-local overrides.
- Introduce a search-result-appropriate `ListingCard` layout in the design system rather than patching Discovery with route-local card markup.
- Preserve crisp image behavior from the prior PR: search cards continue to use `search-card` responsive asset sources sized for a 160 CSS pixel product slot.
- Make the result card scan-first: product identity and market state should appear before repeated metadata.
- Move promotion/status badges out of the product image plane into a reserved card status row so they cannot obscure card art.
- Reduce action competition by presenting one clear primary card action and grouping secondary Buy / Sell / Watch intents as compact secondary affordances.
- Keep metadata such as language and blueprint available only when it differentiates the result set or fits a quiet metadata row; avoid repeating noisy chips ahead of title on every card.
- Reduce vertical drag by tightening result-card spacing, capping title/subtitle lines intentionally, and avoiding stacked full-width micro-buttons in search results.
- Implementation direction chosen: add a design-system-owned `search-result` `ListingCard` layout and have Discovery search opt into it. The route keeps Marketplace facts projected through Discovery but no longer promotes default language/blueprint metadata ahead of product identity.

## Implementation Checklist

- Add or revise a design-system `ListingCard` search-result layout/density that supports:
  - reserved promotion/status row outside media,
  - compact product media slot without border/background chrome,
  - balanced media/content sizing for three-column grids,
  - one primary action plus secondary action grouping,
  - quieter metadata placement,
  - stable responsive dimensions across desktop and mobile.
- Update Discovery search result composition to use the search-result card layout/density.
- Use short visible Buy / Sell / Watch labels while preserving descriptive accessible names and existing market-intent links.
- Use `Supply wanted` / `Available Now` as content-plane status badges rather than media overlays.
- Omit default repeated card metadata before the title; retain non-default language as a quiet metadata line when it differentiates a result.
- Keep item detail, public account listing cards, checkout cards, and unrelated marketplace surfaces unchanged unless they consume the same design-system contract intentionally.
- Update design-system and Discovery tests to cover:
  - action links still preserve dynamic product filters and market intent,
  - promotion/status text is rendered outside the media overlay,
  - search-card responsive image attributes remain present,
  - repeated metadata is not promoted ahead of product identity in the search result card.
- Verify visually with the real marketplace app at desktop and mobile sizes.
- Update `packages/design-system/MARKETPLACE_SYSTEM.md` if the card contract needs more specific search-result guidance.

## Documentation To Promote

- Promote durable card contract changes to `packages/design-system/MARKETPLACE_SYSTEM.md`.
- No ADR is expected unless the implementation changes the meaning of primary marketplace card action or cross-context ownership.

## Verification

- `pnpm --filter @chase-sets/discovery run test -- search-page`: passed.
- `pnpm --filter @chase-sets/design-system run test`: passed.
- `pnpm --filter @chase-sets/app-marketplace-web run test -- search`: passed.
- `pnpm --filter @chase-sets/design-system run typecheck`: passed.
- `pnpm run verify:static`: passed, with existing structure warnings about unrelated single-slice support trend.
- `pnpm run verify:typecheck`: passed.
- Local visual check against `http://localhost:9703/search`: passed at 1440px desktop and 390px mobile after starting marketplace web plus platform API with sandbox `407ae9ce`.
  - Search result cards rendered with `data-card-layout="search-result"`.
  - First six inspected cards had 112-116px rendered product media, content-plane status badges, no media overlay status badge, short visible Buy / Sell / Watch labels, and descriptive accessible link names.
  - Screenshots captured locally at `.codex/search-card-layout-desktop.png` and `.codex/search-card-layout-mobile.png` for review; they are ignored verification artifacts, not retained plan content.
- `pnpm run verify:test`: passed.
- `pnpm run verify:build`: passed.
- `pnpm run verify:db`: passed.

## Goal Completion Criteria

- Retained plan committed with the implementation.
- PR submitted for the completed catalog-card layout follow-up.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
- Local container or sandbox created for this worktree deleted with scoped cleanup.
- Worktree deleted after the retained plan is committed and the PR is merged.
- Remote PR branch deleted after merge when one exists.
- Local branch deleted after the worktree is removed and the PR is merged.
