# Seller Reputation Rows

## Intent

Show account reputation next to marketplace listing and offer choices so users can compare counterparties, not only price and product condition. Provide a direct way to view the account's public feedback and comments for users who want to choose the best counterparties before committing.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-seller-reputation-rows`
- Branch: `codex/seller-reputation-rows`
- Sandbox id: `34dd803d`.
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed.
- pnpm store path: default embedded worktree store, `.codex/worktrees/.chase-sets-pnpm-store`.
- Setup blockers: none known. Main checkout is behind `origin/main` by 11 commits, but this worktree intentionally branched from current `HEAD` per the planning workflow.

## Owning Contexts

- `Reputation` owns Review, Feedback, Review Summary, public review list APIs, and public review summary APIs.
- `Discovery` owns browse and item detail presentation, including buyer-facing listing rows on item detail pages and public seller/listing routes.
- `Marketplace` owns Listing and Offer lifecycle facts, including submitted offers and accepted seller account IDs.
- `Identity` owns account display names. Marketplace and Discovery already project account display names for seller and buyer attribution. Buyer and Seller are transaction roles played by an Account, not separate user types.

## Repo Evidence

- `bounded-contexts/README.md` fixes Listing and Offer ownership to Marketplace and Review ownership to Reputation.
- `bounded-contexts/reputation/README.md` says Reputation owns post-transaction ratings, written feedback, and canonical review summaries.
- `bounded-contexts/reputation/features/reviews/api/route.ts` already exposes public Reputation routes for `GET /accounts/:accountId/review-summary` and `GET /accounts/:accountId/reviews`.
- `bounded-contexts/reputation/features/reviews/read-model/schema.ts` stores public review summaries in `review_summary_pages` and feedback in `reputation_review_pages`.
- `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx` renders the listing choice rows shown in the screenshot from `DiscoveryMarketListing` and currently shows price, seller display name, available quantity, and product summary only.
- `bounded-contexts/discovery/features/item-detail/read-model/queries.ts` loads item-detail listing rows by joining `discovery_market_listings` to `discovery_market_accounts`; those account rows currently carry display name and seller listing availability, not reputation.
- `bounded-contexts/discovery/support/market-support/schema.ts` defines `discovery_market_accounts`, which is the natural Discovery-owned projection table for account-level public seller signals used on listing rows and public seller/listing pages.
- `bounded-contexts/discovery/context.json` subscribes Discovery's market projection to Identity and Marketplace events, but not Reputation events yet.
- `bounded-contexts/discovery/routes/public-seller.tsx` currently has placeholder copy for review history: "reviews visible after orders".
- `bounded-contexts/discovery/routes/public-listing.tsx` uses `SellerTrustCard`, but does not pass a real rating or review count.
- `packages/design-system/src/components/ui/marketplace.tsx` already includes `RatingSummary`, `SellerTrustCard` rating props, and `ListingCard` rating/review-count props, so the design system has canonical primitives for this UI.
- `bounded-contexts/marketplace/features/offers/ui/submitted-offer-detail-page.tsx` renders submitted offer details for the buyer and does not currently show counterparty reputation.
- `bounded-contexts/marketplace/features/offers/ui/offer-match-detail-page.tsx` is seller-facing and primarily shows buyer demand; adding seller reputation there would be redundant because the seller is the current account.

## Resolved Decisions

- Use the term `reputation` for generic account reputation, with role-specific UI labels such as `Seller reputation` on listing rows and `Buyer reputation` on offer rows. Both are backed by Reputation's canonical `Review Summary` and `Feedback`.
- Do not make Marketplace own rating math, feedback text, or review summaries. Marketplace and Discovery may reference account IDs and consume public Reputation facts for the account playing the buyer or seller role on a row.
- Add public account reputation as projected facts in Discovery-owned read models for buyer-facing item detail listing and offer rows, public listing pages, and public seller pages. Discovery may denormalize the summary for fast browse presentation, but Reputation remains the source of truth.
- Add a direct feedback affordance as a link to the account's public feedback surface, not an inline expansion inside dense rows. Rows must stay scannable.
- Show rating and count only when `review_count > 0`. For accounts without reviews, show a neutral "No feedback yet" or role-specific new-account trust cue and still link to the public profile/feedback surface when available.
- The screenshot row should become a four-column desktop row for listings: price/seller, seller reputation, availability, product. On mobile, seller reputation should sit under the seller name before availability.
- Offer rows on Discovery item detail should show the buyer account's reputation because the buyer is the counterparty represented by the row.
- Seller-facing Marketplace offer match rows and details should show buyer reputation, because the seller is evaluating buyer demand.
- Buyer-facing submitted offer details should only show seller reputation after acceptance, when `accepted_seller_account_id` identifies a real seller counterparty.

## Open Questions

- None.

## Recommended Answer

Implement account reputation across listing and offer rows. Listing rows show the listing account's reputation as seller reputation. Offer rows and offer match details show the buyer account's reputation as buyer reputation. Buyer-submitted offer details show seller reputation only after acceptance, when a seller account exists.

## Why This Matters

The platform has two transaction roles but one account-level reputation model:

- Listings represent seller supply, so the visible counterparty is the seller account.
- Submitted offers represent buyer demand, so the visible counterparty is the buyer account.
- Accepted offers have both buyer and seller accounts and can show the relevant counterparty reputation depending on viewer context.

This matches the context map: Buyer and Seller are roles played by Account, while Reputation evaluates accounts as review subjects.

## Implementation Checklist

- Add Reputation integration event subscription metadata to Discovery for `reputation.review.submitted`, `reputation.review.updated`, and `reputation.review.withdrawn`, using public Review Summary facts derived from active reviews.
- Extend `discovery_market_accounts` with account reputation columns such as `average_rating`, `review_count`, rating distribution if useful, and `reputation_updated_at`.
- Project Reputation review summary changes into Discovery market accounts keyed by `subjectAccountId`.
- Rebuild Discovery listing/offer/public seller/public listing query contracts to return reputation fields for seller and buyer account rows.
- Update `DiscoveryMarketListing`, `DiscoveryOffer`, `DiscoveryPublicListing`, and `DiscoveryPublicSeller` client contracts with nullable rating/count fields and a feedback/reviews href or account profile target.
- Update item-detail listing cards to render seller `RatingSummary` plus a small feedback link when a target exists.
- Update item-detail offer cards to render buyer `RatingSummary` plus a small feedback link when a target exists.
- Update public listing `SellerTrustCard` to pass the real rating/count and link to the seller feedback surface.
- Update public seller route header facts to show actual review summary instead of placeholder review-history text, and expose recent public feedback/comments below the header if route data includes reviews.
- Update seller-facing Marketplace offer match list/detail contracts to include buyer reputation, either by projecting public Reputation facts into Marketplace's account read model or by route composition against the public Reputation client.
- For accepted submitted offers, decide whether Marketplace should call the public Reputation API in the route loader or consume a small Reputation summary client using `accepted_seller_account_id`; keep this as route composition, not Marketplace-owned reputation state.
- Add localization keys for reputation labels and empty/new-seller copy.
- Add or update tests:
  - `bounded-contexts/discovery/tests/item-detail-commerce-panel.test.tsx` for listing row seller rating, offer row buyer rating, counts, and feedback links.
  - Discovery market projection/query tests for Reputation summary updates.
  - Public seller/public listing route tests for actual review summary display.
  - Marketplace offer match list/detail tests for buyer reputation.
  - Marketplace submitted-offer detail tests for accepted-offer seller reputation.
  - Design-system tests only if a new reusable seller reputation row primitive is needed.

## Stress Test

- Normal flow: account has active reviews; listing and offer rows show rating/count and link to feedback.
- New account: no reviews; row shows a neutral trust cue without blocking checkout or offer acceptance.
- Stale projection: listing rows may temporarily show older summary, but the feedback link still lands on Reputation-backed/public seller details.
- Review withdrawal: Reputation recomputes summary; Discovery projection updates count/rating and can fall back to "No feedback yet".
- Cross-context handoff: Reputation publishes review facts/summary facts; Discovery and Marketplace consume public account reputation facts for row presentation; neither calculates ratings.
- Failure/cancellation: lack of Reputation data must not hide listings or block buyer checkout.
- Low-value card economics: row addition must be compact and scannable so buyers can compare low-price listings without extra clicks unless they want comments.

## Documentation To Promote

- Consider adding `bounded-contexts/discovery/docs/seller-reputation-on-market-surfaces.md` if implementation introduces a new Discovery projection from Reputation.
- Update `bounded-contexts/discovery/README.md` and `context.json` if Discovery formally subscribes to Reputation events.
- Update `docs/README.md` only if a durable docs page is added.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
