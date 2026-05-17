# Account Reputation Summary

## Intent

Replace separate reputation columns with one compact account identity component: account name first, reputation directly beneath it, and the whole unit linking to the account reputation surface. Reuse that component anywhere a buyer or seller counterparty is shown, including item-detail listings/offers, submitted offers, offer matches, cart seller choices, and checkout seller groups.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-account-reputation-summary`
- Branch: `codex/account-reputation-summary`
- Sandbox id: `ceb7f1bb`.
- Dependency setup status: complete via `pnpm run deps:install`; `pnpm run sandbox:doctor` passed.
- pnpm store path: default embedded worktree store, `.codex/worktrees/.chase-sets-pnpm-store`.
- Setup blockers: none known. Main checkout is behind `origin/main`, but this worktree intentionally branched from current `HEAD` per the planning workflow.

## Owning Contexts

- `Reputation` owns Review, Feedback, and canonical Review Summary.
- `Discovery` owns browse and item detail presentation, including public listing/offer rows where buyers compare counterparties.
- `Marketplace` owns Listing and Offer lifecycle facts, including submitted offers, offer matches, and accepted seller account IDs.
- `Checkout` owns cart and checkout session presentation. It can show projected/public counterparty reputation but must not own rating math.
- `Identity` owns account display names. Buyer and Seller are transaction roles played by an Account, not separate roots.
- `Design System` owns the shared component because this visual pattern crosses bounded contexts and must stay canonical.

## Resolved Decisions

- Add a design-system component for account plus reputation. It accepts account name, href, average rating, review count, and fallback copy; it does not fetch or compute reputation.
- The component links to the account reputation surface when a target exists. In current public marketplace surfaces the stable public target is the seller profile route (`/sellers/:sellerSlug`) or the signed-in review summary (`/account/reviews`) for the current account; rows without a public target render as plain text until a public account reputation route exists.
- Do not add standalone `Seller reputation` or `Buyer reputation` columns. On dense rows, the account component belongs in the counterparty column: seller under price for listings, buyer under offer price for offer rows, seller option labels in cart, and seller group headings in checkout.
- Reuse prior projection work where useful: Discovery and Marketplace can denormalize public Review Summary facts for fast presentation, while Reputation remains the source of truth.
- Order columns by buyer/seller decision relevance. Listing rows: Price and seller, Available, Product. Offer rows: Offer and buyer, Quantity/availability, Product or listing details, Status/actions as needed.
- New accounts show neutral fallback copy such as `No feedback yet`; no reputation data should block add-to-cart, checkout, listing selection, or offer acceptance.

## Repo Evidence

- `bounded-contexts/README.md` fixes Listing and Offer ownership to Marketplace, Cart to Checkout, and Review to Reputation.
- `bounded-contexts/reputation/README.md` says Reputation owns post-transaction ratings, written feedback, and canonical Review Summary.
- `bounded-contexts/reputation/features/reviews/api/route.ts` already exposes public summary/review APIs for accounts.
- `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx` renders the screenshot-style listing rows and currently separates price, seller, available, and product.
- Existing worktree `20260517-seller-reputation-rows` proves the reputation projection path and tests, but its UI creates separate reputation columns that this change intentionally replaces.
- `packages/design-system/src/components/ui/marketplace.tsx` already has `RatingSummary`, `SellerTrustCard`, and marketplace row/card primitives, making it the right home for the reusable account identity component.
- `bounded-contexts/checkout/features/cart/ui/cart-page.tsx` currently shows seller choices in select labels only; Checkout can surface account/reputation in that seller-choice area without owning reputation state.

## Implementation Checklist

- Add the design-system account reputation component and focused tests.
- Bring forward useful Reputation projection/query fields from the prior seller-reputation work for Discovery and Marketplace.
- Update Discovery item-detail listing rows to use the component under price and remove the standalone reputation column.
- Update Discovery item-detail offer rows to use the component under offer price for buyer reputation.
- Update public listing/seller pages to use real reputation values through existing design-system trust surfaces where appropriate.
- Update Marketplace offer match list/detail and submitted-offer list/detail to use the shared component instead of separate reputation blocks.
- Update Checkout cart seller-option contracts/read models where needed so seller options carry account IDs/slugs/reputation and can render the shared component near seller choices.
- Update Checkout session fulfillment seller groups to render seller account and reputation when preview data provides it.
- Add/adjust localization keys for fallback copy only where the bounded-context UI owns text.
- Run focused unit tests for design-system, Discovery item-detail, Marketplace offers, and Checkout cart/session UI.
- Run `pnpm run sandbox:doctor` after dependency setup and a broader typecheck/test command if available within time.

## Stress Test

- Normal flow: reviewed accounts show name, rating, count, and link target in one scannable unit.
- New account: component shows name and `No feedback yet`, preserving marketplace liquidity for low-value cards.
- Stale projection: rows may show an older summary temporarily, but links still lead to the best available account reputation/profile surface.
- Review withdrawal: projected count/rating can drop to fallback without layout shifts or hidden rows.
- Partial data: missing slugs or hrefs produce non-link text, not broken anchors.
- Cross-context handoff: Reputation owns summary facts; Discovery, Marketplace, and Checkout only display projected or composed public facts.
- Dense/mobile rows: no added standalone column; account and reputation travel together and wrap within their cell.

## Documentation To Promote

- No durable docs required unless implementation adds a new public account reputation route or materially changes projection ownership.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
