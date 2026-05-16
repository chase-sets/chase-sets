# Offer Match Listing Prices

## Intent

Revamp `/account/offers/matches` so sellers can decide whether current buyer demand is close enough to their own listing price. The page should prioritize the best actionable matches first, use Marketplace listings as the seller-facing base, and expose listing price, best offer, gap, match percentage, quantity, buyer, and acceptance readiness.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-offer-match-listing-prices`
- Branch: `codex/offer-match-listing-prices`
- Base: current source repo `main` at `8cc4f1e6`
- Sandbox id: `b5590037`
- Dependency setup: `pnpm run deps:install` completed successfully.
- Sandbox status: `pnpm run sandbox:doctor` completed successfully.
- Services: Marketplace `http://localhost:8953`, Platform API `http://localhost:8962`
- Setup blockers: none found.

## Owning Contexts

- Marketplace owns the behavior. The context map fixes `Listing` and `Offer` under Marketplace, and Marketplace README states it owns listing lifecycle, offer capture/review, seller asking prices, buyer proposed prices, and marketplace-wide demand visibility.
- Inventory remains an upstream availability signal only. Inventory README says it owns account-held stock and operational availability, and does not own listings or offers.
- Pricing is not the owner of this flow. This is not a recommendation or repricing workflow; it is a seller decision surface over existing Marketplace listings and offers.

## Resolved Decisions

- Treat `Offer Match` as a listing-backed seller view, not an inventory-backed supply view.
  - Evidence: Marketplace glossary says accounts can review Offer Matches only when they have matching active listings.
  - Implementation consequence: query active `marketplace_listing_pages` first, attach the best submitted offer per listing/product, and keep inventory joins only for visible/fulfillable quantity.

- Define "best match" as the submitted offer with the highest offer-to-listing-price percentage for a seller listing, then highest offer price, then most recent listing update/id tie-breakers.
  - Why: the seller wants to know whether demand is close to their asking price; price closeness is the useful ranking signal.
  - Consequence: a $9 offer on a $10 listing outranks a $40 offer on a $100 listing because it is closer to the seller's decision threshold.

- Preserve existing acceptance and sell-list behavior by keeping `offer_id` as the action identity.
  - Evidence: detail, accept, terms preview, and sell-list APIs are offer-scoped today.
  - Consequence: the list becomes listing-informed without forcing a wider API break across acceptance routes.

- Expose buyer and quantity context alongside price context.
  - Best visible data: listing price, best offer, gap, offer/listing percentage, requested quantity, listing visible quantity, seller listing availability, buyer display name, and sell-list state.

- Keep the list row offer-scoped while resolving its seller context from the best matching active listing.
  - Why: existing acceptance, terms preview, sell-list, realtime patches, and detail routes are offer-scoped.
  - Consequence: the page keeps stable offer actions while the decision data is listing-backed.

## Open Questions

- None blocking. The user explicitly asked to base the flow on listings, show listing price versus best offer, and put best matches first.

## Implementation Checklist

- Completed: extended Marketplace offer match read-model rows/contracts with listing identity and price comparison fields.
- Completed: changed offer-match queries to resolve each offer through the seller's best matching active listing and order best matches first by fulfillment readiness, offer-to-listing percentage, offer price, and quantity.
- Completed: updated account offer match list and detail UI copy, metrics, sell-list summary, and table columns to make listing price versus best offer the primary decision surface.
- Completed: updated localization keys for the new language.
- Completed: updated unit/API tests around read model shape, list ordering data, and UI rendering.
- Completed: ran targeted Marketplace offer tests and relevant static checks.
- Partial: local browser reached the sign-in page, but the in-app browser could not type into the email field and blocked an auto-submit sign-in page. Authenticated local API verification confirmed the new fields and ordering; authenticated visual verification should be repeated manually or after browser input works.

## Documentation To Promote

- Keep this plan with the implementation for reviewer context.
- Promote a Marketplace docs note only if the listing-backed offer match policy becomes broader than this UI/read-model behavior.

## Goal Completion Criteria

- Implementation happens in this worktree and branch.
- Durable docs are promoted if the behavior becomes a context policy beyond the route/read model.
- Verify automated tests for Marketplace offer/read-model/UI behavior.
- Verify visual rendering on desktop and mobile.
- Submit a PR, get CI passing, merge, and confirm the staging route `https://marketplace-staging.chasesets.com/account/offers/matches` shows listing-backed best matches.
- Retain this plan at `.codex/plans/20260515-offer-match-listing-prices.md`.

## Verification Log

- `pnpm --filter @chase-sets/marketplace run test` passed: 13 files, 36 tests.
- `pnpm --filter @chase-sets/app-marketplace-web run test` passed: 19 files, 79 tests.
- `pnpm run check:localization` passed.
- `pnpm run check:structure` passed.
- `pnpm run typecheck` passed.
- `pnpm run dev:marketplace-full` bootstrapped sandbox `b5590037` and served Marketplace at `http://localhost:8953`.
- Local authenticated API check against `GET http://localhost:8962/api/marketplace/account/offers/matches?limit=5&offset=0` returned listing-backed rows ordered by `offer_to_listing_price_bps` descending after readiness, with `listing_price_amount`, `offer_price_gap_amount`, and `offer_to_listing_price_bps` populated.
- `pnpm run dev:down` stopped sandbox `b5590037`.
