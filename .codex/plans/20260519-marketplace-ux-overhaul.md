# Marketplace UX Overhaul

## Intent

Overhaul search, item detail, buy cart, and sell list around one consistent marketplace model:

Catalog -> Items -> Products -> Listings / Offers.

Users transact against Products, not generic Items. The UI exposes three top-level intents:

- Buy
- Sell
- Watch

The implementation should support both first-time accounts and advanced accounts without exposing every action everywhere. Search captures intent quickly. Item detail resolves Product selection and exact counterparty selection. Buy cart and sell list hold batch execution, Smart Match, optimization, and fallback rules.

## Worktree

- Path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/20260519-marketplace-ux-overhaul`
- Branch: `codex/marketplace-ux-overhaul`
- Sandbox id: `6cf5b7d7`
- Dependency setup status: `pnpm run deps:install` completed successfully.
- pnpm store path: `D:/Users/ToddS/Source/Repos/chase-sets/.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none. `pnpm run sandbox:doctor` completed successfully.

## Owning Contexts

Catalog owns Product identity and product resolution.

Evidence:

- `bounded-contexts/catalog/README.md` says Product is derived from `catalog_item_id`, canonical dimension order, and selected option ids.
- `bounded-contexts/catalog/GLOSSARY.md` says a Catalog Item cannot be sold without a Product and downstream contexts should use `catalog_item_id`, `product_id`, and `selected_options`.

Discovery owns search, browse, item detail presentation, product selection, and Product Alerts.

Evidence:

- `bounded-contexts/discovery/README.md` owns browse, search, detail, filter state, catalog item detail presentation models, and Product Alerts.
- `bounded-contexts/discovery/context.json` subscribes to Marketplace listing/offer facts through `discovery-market-projection`.
- `bounded-contexts/discovery/features/search/ui/search-page.tsx` currently renders item cards and bulk-adds matching products to cart.
- `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx` already separates buy and sell market intent, selected listing, selected offer, and selected product context.

Marketplace owns Listings, Offers, offer matching, and seller-side listing/offer lifecycle decisions. Marketplace currently stores selected offer-match sell-list state, but the overhaul should move durable Sell List execution state into Checkout because it is a pre-order checkout plan.

Evidence:

- `bounded-contexts/marketplace/README.md` says Listings and Offers target products, not bare catalog items.
- `bounded-contexts/marketplace/GLOSSARY.md` defines Listing, Offer, Offer Acceptance, and limited offer demand visibility.
- `bounded-contexts/marketplace/features/offers/read-model/schema.ts` already has `marketplace_buyer_offer_match_sell_list_pages`, which is useful evidence of current behavior but should not be treated as final ownership.
- `bounded-contexts/marketplace/features/offers/api/runtime.ts` already supports accepting a batch of queued offer matches with an `acceptanceBatchId`; Checkout should orchestrate the batch plan, while Marketplace validates and records the accepted Offer facts.

Checkout owns Buy Cart, Sell List, and Checkout Session orchestration before orders exist.

Evidence:

- `bounded-contexts/checkout/README.md` owns cart intent and active purchase workflow.
- `bounded-contexts/checkout/features/cart/domain/domain.ts` already supports product lines through `fulfillmentMode: "optimize"` and exact selected listing lines through `fulfillmentMode: "locked-listing"` plus `lockedListingId`.
- `bounded-contexts/checkout/features/sessions/domain/domain.ts` already exposes optimization goals: `lowest-total` and `fewest-shipments`.
- Sell List models the same pre-commitment orchestration pattern as Buy Cart: selected counterparty lines, product lines, Smart Match, optimization, fallback rules, and final handoff into Ordering/Payments/Fulfillment. The initiator changes from buyer to seller, but the execution-plan shape belongs with Checkout.

Ordering owns committed execution after checkout or accepted offers.

Evidence:

- `bounded-contexts/ordering/README.md` says Checkout lines express buyer intent for a product and concrete listing/inventory matching happens when Ordering creates orders.
- `bounded-contexts/ordering/features/orders/api/runtime.ts` already handles locked listing checkout lines separately from optimized demand.

Notifications owns Notification Center and delivery preferences; Discovery owns Product Alert rules.

Evidence:

- `bounded-contexts/discovery/docs/product-alerts.md` says Product Alerts are Discovery-owned and match Listing/Offer signals.
- `bounded-contexts/notifications/README.md` says Notifications owns delivery policy and notification center, not source business rules.

## Resolved Decisions

1. Use Product as the transactional target everywhere.

Search results can represent Items, but Buy/Sell/Watch actions must resolve a Product first. The primary UI can default to the most useful Product, but command payloads must include `catalog_item_id`, `product_id`, `selected_options`, and `product_summary`.

2. Rename the account-facing buy basket to `Buy Cart`.

Checkout can keep the existing durable term `Cart` for buyer-side state if desired, but marketplace UI copy and nav should distinguish `Buy Cart` from `Sell List`. The bounded-context scope should expand from buyer purchase checkout to commerce checkout orchestration.

3. Keep current buy cart line mechanics and improve language.

Existing cart lines already model the two required line types:

- Selected listing line: `fulfillmentMode = "locked-listing"` and `lockedListingId` populated.
- Product line: `fulfillmentMode = "optimize"` and no `lockedListingId`.

Recommended UI language:

- `Selected listings`
- `Products`
- `Smart Match listings`
- `Fallback: make offers for unavailable quantity`

4. Move durable Sell List execution state into Checkout.

Sell List should not reuse Buy Cart, and sellers should never see cart language for selling. But the owning context should be Checkout because Sell List is a pre-order execution plan: selected offers, product lines, Smart Match offers, optimization, fallback rules, fee/payment readiness, and final orchestration into Ordering. Marketplace remains the owner of Offers, Listings, Offer Acceptance, and Listing creation. Inventory remains the owner of stock and ship-from readiness. Checkout owns the seller-initiated plan that coordinates those facts before commitment.

5. Introduce `Smart Match` as user-facing language over existing optimization/matching behavior.

Use:

- `Smart Match listings` in Buy Cart.
- `Smart Match offers` in Sell List.

Keep implementation terms such as `optimize`, `locked-listing`, and `acceptanceBatchId` inside context code and API contracts.

6. Keep Level 3 controls out of item detail by default.

Item detail should present:

- selected product
- market book
- action accordion rail with Buy / Sell / Watch

Advanced optimization and fallback rules belong in Buy Cart and Sell List review.

7. Alerts stay separate from buying and selling.

Create alerts from Discovery item/product surfaces. Manage alert delivery through Notifications settings/center. Do not turn alerts into cart/list lines.

## Recommended UX Plan

Search / Browse:

- Each result remains an Item card.
- Add visible selected/default Product summary using `ProductOptions`.
- Show market summaries for the selected/default Product, not only item-wide listing counts:
  - Lowest listing and available quantity.
  - Highest public offer/demand signal where visible.
- Replace the current single `View details` action with a compact Buy / Sell / Watch action group:
  - Buy primary: `Add product to buy cart`.
  - Buy menu: `Buy lowest listing`, `Add product to buy cart`, `Make offer`, `Watch listings`, `View listings`.
  - Sell primary: `Add product to sell list`.
  - Sell menu: `Accept highest offer`, `Add product to sell list`, `Create listing`, `Watch offers`, `View offers`.
  - Watch primary/menu: `Watch listings`, `Watch offers`.
- If product options are unresolved, open a product selector sheet before executing the action.
- Keep the existing bulk-add search flow, but rename it from generic cart language to `Add matching products to buy cart`.
- Search result actions can use compact split actions/menus; the action accordion rail is specifically the item-detail pattern where the user needs to compare selected listing/offer actions against selected product actions.

Item Detail:

- Reframe the page as three zones:
  - Select product.
  - Market book.
  - Action accordion rail.
- Keep Discovery as owner of the page and product selector.
- Evolve the current Buy/Sell toggle by adding Watch, rather than replacing the interaction with a totally new tab pattern.
- Use the existing action accordion rail pattern effectively as the main right-rail structure:
  - Buy accordion: selected listing actions first, then product-level buy actions.
  - Sell accordion: selected offer actions first, then product-level sell actions.
  - Watch accordion: listing alert and offer alert actions for the selected product.
- Add a new market-book tab set for Listings / Offers / Sales / Details. This is a new detail-page structure, not merely a relabeling of current sections. In the first implementation, Listings and Offers are required; Details can wrap the existing item information; Sales can start as a deferred/empty state if no Pricing/Ordering product-history read model exists yet.
- Visually separate selected counterparty actions from selected product actions:
  - Buy selected listing: `Buy now`, `Add selected listing to buy cart`.
  - Buy selected product: `Add product to buy cart`, `Make offer`, `Watch listings`.
  - Sell selected offer: `Sell now`, `Add selected offer to sell list`.
  - Sell selected product: `Add product to sell list`, `Create listing`, `Watch offers`.
- Mobile uses the same Buy / Sell / Watch intent model inside the commerce bottom sheet, with accordion sections matching the desktop rail.

Buy Cart:

- Rename visible page title/nav to `Buy Cart`.
- Split lines into:
  - Selected listings.
  - Products.
- Preserve Checkout-owned cart state and existing routes.
- Surface `Smart Match listings` for optimized product lines.
- Add review settings:
  - Optimize for `Lowest total cost` or `Fewest packages`.
  - Fallback: `Make offers for unavailable quantity`.
  - Max offer price and offer expiration.
- Implementation note: fallback-to-offers is cross-context. Checkout can own the user's fallback intent in cart/session state, but final offer submission must call Marketplace because Offer remains Marketplace-owned. This likely requires a new Checkout-to-Marketplace orchestration path analogous to Offer Intent.

Sell List:

- Create a first-class `/account/sell-list` route contributed by Checkout.
- Move the current offer-match sell-list UI out of the Offer Matches page into the Checkout-owned Sell List page. Offer Matches becomes a Marketplace source list that can add selected offers to Sell List.
- Split lines into:
  - Selected offers.
  - Products.
- Move current selected-offer sell-list state out of Marketplace read-model storage and into Checkout-owned Sell List state. Rename current internal/read-model surfaces away from `buyer_offer_match_sell_list` as part of the breaking cleanup.
- Add product lines for selling a Product and quantity:
  - `Smart Match offers`.
  - Fallback: `Create listings for unsold quantity`.
  - Minimum listing price and listing duration.
- Seller checkout should trigger Marketplace offer acceptance for selected offers and Marketplace listing creation/publication for fallback listings, then hand committed facts to Ordering/Payments/Fulfillment through the existing event-driven flow.
- For selected offers, buyer payment information should already have been captured by the Offer Intent path. Seller-side Sell List review should show payment readiness and stale-payment recovery, but should not ask the seller to collect buyer payment information.
- Product-line fallback will need Inventory involvement because listing creation requires account-held stock and storage/ship-from data. If the account has no matching stock, the Sell List line should become a guided create-inventory/listing path rather than pretending it can list unavailable stock.

Navigation / IA:

- Recommended top-level nav labels:
  - Browse
  - Buy Cart
  - Sell List
  - Alerts
- Keep account-management routes for Listings, Offer Matches, Submitted Offers, Purchases, Sales, Inventory, and Settings, but reduce their prominence relative to the primary Browse / Buy Cart / Sell List / Alerts workflow.
- Notifications may keep the top-nav `Notifications` label on desktop if preferred, but bottom-nav `Alerts` already aligns with the proposed model.

Design System:

- Build or extend design-system primitives first, then consume them from contexts.
- Likely primitives:
  - Product action split button / action menu.
  - Market summary pair for lowest listing / highest offer.
  - Action accordion rail with Buy / Sell / Watch intent sections.
  - Market-book tabs for Listings / Offers / Sales / Details.
  - Cart/list line grouped sections.
  - Smart Match settings panel.
- Do not add local component overrides in deployables.

## Implementation Checklist

1. Durable language and design-system planning
   - Add or update durable docs for `Buy Cart`, `Sell List`, `Smart Match`, selected listing/offer lines, and product lines.
   - Update cross-context glossary only for terms used across multiple contexts.
   - Extend design-system marketplace guidance for action accordion rails, product action menus, market-book tabs, and cart/list review sections.

2. Search read model and UI
   - Extend Discovery search market summaries to include product-specific popular/default Product data and offer demand summary.
   - Keep item-level search result identity but make actions product-scoped.
   - Add product selector sheet for unresolved product actions.
   - Add Buy / Sell / Watch action group using design-system primitives.
   - Update search tests and acceptance tests.

3. Item detail action rail
   - Refactor Discovery item detail commerce into Buy / Sell / Watch action accordion rail sections.
   - Add Watch to the current Buy/Sell intent toggle.
   - Add new Listings / Offers / Sales / Details market-book tabs.
   - Keep Listings and Offers market book rows selectable.
   - Add selected listing/selected offer action distinction.
   - Add Watch accordion content using existing Product Alert creation.
   - Update mobile commerce bottom sheet behavior and tests.

4. Buy Cart review
   - Rename UI copy to Buy Cart while keeping Checkout-owned `Cart` domain term.
   - Group locked listing lines and optimized product lines.
   - Rename optimized behavior to Smart Match in UI.
   - Expose optimization goal selection.
   - Plan and then implement fallback-to-offer intent only if approved as in-scope for the first implementation.

5. Sell List foundation
   - Expand Checkout context language from buyer checkout only to commerce checkout orchestration before orders exist.
   - Create a Checkout-owned Sell List route and state model.
   - Move current selected-offer sell-list behavior from Marketplace read-model storage into Checkout Sell List state.
   - Add nav contribution for Sell List.
   - Rename current user-facing Offer Match page actions to source-list behavior.
   - Preserve batch acceptance and fee quote confirmation through Marketplace command calls.
   - Rename durable table/API names now, since the project is greenfield and breaking changes are encouraged when they reduce entropy.

6. Sell List product lines
   - Add Checkout-owned Sell List line state for product/quantity lines.
   - Project matching offers by product, highest payout, and fulfillment readiness.
   - Add fallback create-listing settings.
   - Integrate Inventory validation for account-held stock and storage/ship-from readiness.
   - Add batch review tests covering enough stock, partial stock, stale offers, listing availability disabled, stale fee quote, and replay/idempotency.

7. Verification
   - Unit tests for new domain/read-model behavior.
   - Route/action tests for search, item detail, buy cart, sell list, offer acceptance, offer fallback, and listing fallback.
   - Design-system tests for new primitives.
   - Playwright coverage for core flows:
     - Search -> add product to Buy Cart.
     - Search -> make offer.
     - Item detail -> buy selected listing now.
     - Item detail -> add selected listing to Buy Cart.
     - Item detail -> accept selected offer now.
     - Item detail -> add selected offer to Sell List.
     - Sell List -> batch accept selected offers.
     - Product alert creation from Watch action rail.

## Stress Tests

Normal flow:

- New user can search, select a Product, buy now or add to Buy Cart without understanding optimization.
- Selling account can select an Offer and Sell Now without leaving item detail.
- Advanced account can build multi-line Buy Cart and Sell List plans.

Partial flow:

- Search result action with unresolved required dimensions opens product selection first.
- Buy Cart product line with no supply clearly shows waiting/fallback state.
- Sell List product line with no inventory becomes a create-inventory/listing recovery path.

Stale data / replay:

- Listing selected in item detail may be unavailable by checkout start; Checkout/Ordering must revalidate active supply.
- Offer selected in Sell List may already be accepted; Marketplace skips it and reports why.
- Fee quote fingerprints for offer acceptance and listing creation must be refreshed before final commitment.
- Product Alert notifications must remain idempotent across replay.

Cross-context handoff:

- Discovery captures user intent and Product resolution only.
- Checkout owns Buy Cart, Sell List, and checkout execution-plan state.
- Marketplace owns Offer and Listing commands and emits accepted/published facts.
- Ordering creates committed purchases/sales after Checkout or Marketplace acceptance.
- Inventory validates stock and creates/updates inventory-owned facts before listing fallback.

Failure / cancellation:

- Anonymous cart behavior should continue for Buy Cart product lines where supported.
- Offer fallback should not create payment or order until a seller accepts.
- Sell List batch acceptance must be partially successful and explain skipped rows.
- Listing fallback must not publish unavailable stock.

Low-value card economics:

- Buy Cart optimization should keep fewest packages available because shipping can dominate low-value card margins.
- Sell List optimization should keep highest payout and fewest shipments visible.
- Fallback offer/listing thresholds must be visible in review summaries so users understand margin impact before committing.

## Contradictions And Risks

- Search currently shows item-wide active listing summary only. The proposed UI needs selected/default Product summaries and highest offer visibility; Discovery market projection likely needs richer product-level summary data.
- The current Buy Cart is Checkout-owned and uses the generic UI label `Cart`. The proposed IA wants `Buy Cart`; this is a UX rename, not a domain ownership change.
- The current Sell List exists only for selected offer matches and uses an awkward internal table name: `marketplace_buyer_offer_match_sell_list_pages`. Since the project is greenfield, move this state to Checkout and rename it during the overhaul even though it increases migration/test churn.
- `Product Alert` docs currently say Product Alerts should not be a peer account-navigation destination beside Notifications. The proposed top-level `Alerts` label is acceptable only if it points to Notification Center/settings or a compact alert-management surface, not a new Discovery-owned alert destination that contradicts the doc.
- Product-line Sell List with fallback listing creation is not just UI. Checkout can own the execution plan, but Marketplace/Inventory must still validate listing commands and account-held stock/ship-from readiness.
- Buy Cart fallback-to-offers is not present in current Checkout cart domain. It needs explicit orchestration to Marketplace Offer creation and should not be hidden inside Ordering.

## Resolved Implementation Decision

Decision: Expand Checkout to own durable Sell List state for both selected offers and product lines. Do not submit the PR until user review.

Accepted answer: expand Checkout to own durable Sell List state for both selected offers and product lines now.

Why it matters: Sell List behavior has real checkout-plan state: quantity, selected offers, minimum listing price, fallback rules, Smart Match settings, skipped/partial outcomes, buyer payment readiness, fee quote confirmation, and Inventory readiness. Keeping part of it as route-only/read-model state would make event replay, partial acceptance, and future optimization harder.

Repo evidence:

- Checkout already owns pre-order orchestration for cart and checkout sessions.
- Checkout already has optimization goal language and fulfillment preview mechanics.
- Marketplace already owns Listings and Offers before orders exist; those remain source liquidity and command owners, not execution-plan owners.
- Current selected-offer sell-list state is a Marketplace table, but that reflects current implementation, not the clean bounded-context model.
- Offer acceptance already supports batch identity through `acceptanceBatchId`.
- Inventory owns stock truth, so durable Sell List product lines need Checkout-owned orchestration that calls Inventory/Marketplace rather than taking over their facts.

Consequence of choosing differently: moving only selected offers first can ship faster, but product-line selling will either be deferred or scattered across route code, read-model rows, and listing forms. That would conflict with the repo preference for bounded contexts as canonical homes for behavior.

## Documentation To Promote

Likely durable documentation after review:

- `bounded-contexts/checkout/docs/sell-list.md`
- `bounded-contexts/checkout/docs/buy-cart-smart-match.md`
- `bounded-contexts/discovery/docs/product-action-surfaces.md`
- `packages/design-system/MARKETPLACE_SYSTEM.md` updates for action accordion rail, market-book tabs, and cart/list review patterns
- `docs/GLOSSARY.md` additions for Buy Cart, Sell List, and Smart Match if accepted as cross-context terms

## Goal Completion Criteria

- User review completed before PR submission, per explicit instruction.
- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.

## Implementation Progress

Completed in the review branch:

- Discovery item detail now uses Buy / Sell / Watch intent controls in the commerce rail.
- The item-detail action rail uses accordion sections for Buy, Sell, and Watch; alert creation moved out of Buy/Sell and into Watch.
- Item detail Sell now separates selected-offer Sell List actions from product-level `Add product to Sell List`, so sellers can save product intent even when no acceptable offer is selected.
- Item detail Sell now gates product-level Sell List and listing creation on listing-management capability while keeping selected-offer actions available to offer-review accounts.
- Item detail has a new market book with Listings / Offers / Sales / Details tabs. Sales is a deferred empty state until a sales-history read model exists.
- Discovery search item cards now expose compact product-intent actions (`Add product to Buy Cart`, `Add product to Sell List`, `Watch product`) that preserve product option filters into the item-detail route.
- Discovery search bulk-add copy now names Buy Cart explicitly for the trigger, preview dialog, updated state, and review action.
- Checkout now has a first-class Sell List slice with event-sourced selected-offer/product lines, read-model schema, API routes, client methods, and `/account/sell-list` review UI.
- Checkout Sell List product lines now merge repeated product-level seller intent by increasing durable quantity, matching the Buy Cart quantity-control pattern.
- Checkout Sell List API route coverage now verifies product-line writes, selected-offer writes, quantity counting, line removal, and guest checkout blocking.
- Discovery item-detail `add-to-sell-list` now writes selected-offer lines into Checkout Sell List instead of Marketplace sell-list storage.
- Marketplace Offer Matches now behaves as a source list: list/detail actions post selected offer ids to the Checkout-owned Sell List route, where Checkout resolves the Marketplace offer snapshot and stores durable selected-offer seller intent.
- The account cart review surface now presents as `Buy Cart`, uses Smart Match language for optimized listing matching, and exposes first-pass Smart Match review settings for lowest total cost plus offer fallback.
- Buy Cart review now groups exact `Selected listings` separately from product-level `Products`.
- User-facing search, item detail, account nav, checkout start, and payment recovery copy now consistently distinguishes `Buy Cart` from seller-side `Sell List`.
- Checkout Sell List, Marketplace source-list, and Discovery selected-offer copy now consistently treat `Sell List` as the named user-facing review surface.
- The cross-context glossary now indexes `Buy Cart`, `Sell List`, and `Smart Match` back to Checkout ownership.
- Marketplace API docs and OpenAPI now expose the Checkout-owned `/api/marketplace/account/sell-list` surface and mark legacy Marketplace `match-sell-list` endpoints as deprecated compatibility surfaces.
- Checkout and Marketplace docs/glossaries now describe Checkout-owned Sell List review state and Marketplace-owned Offer/Listing lifecycle.
- Design-system marketplace guidance now covers Buy / Sell / Watch product actions, item-detail action accordion rails, market-book tabs, and Buy Cart / Sell List review grouping.
- The shared design-system accordion now supports disabled items so action rails can present unavailable selected-listing, selected-offer, and product-level actions without letting users expand them.

Deferred but still planned:

- Full product-specific search market summaries with highest-offer demand.
- Product selector sheet directly on search results for unresolved dimensions.
- Persisted Buy Cart fallback settings such as max offer price and offer expiration.
- Sell List execution from review into Marketplace batch offer acceptance and fallback listing creation.
- Removal/migration of the legacy Marketplace sell-list storage/API. User-facing Offer Matches has been rewired as a Checkout Sell List source list, but the legacy API/read model remains for a later breaking cleanup.
