# Checkout Surface Audit

Milestone #17 and issue #1099 use this audit to connect the current Chase Sets checkout implementation to the Shopify-simple target for Buy Cart and Sell List checkouts. Evidence was captured on 2026-06-09 from `origin/main` at `fd71ead4`.

The target is a fresh-state rebuild. Chase Sets has not launched, so the milestone should not preserve abandoned checkout sessions, old checkout links, legacy read-model payloads, dual checkout screens, or dense marketplace-engine UI as customer-facing compatibility layers.

## Summary Findings

- Checkout already owns the right intent boundaries: Buy Cart intent, Sell List intent, checkout session lifecycle, selected shipping option, checkout review state, and order/payment orchestration.
- The customer-facing surfaces expose too much marketplace machinery. Seller allocation, fulfillment preview revisions, Smart Match tuning, fallback listing execution, fee fingerprints, payout readiness, and detailed package rules are correct domain concepts but should not sit inside the main checkout form.
- Unassigned fulfillment must be resolved before checkout starts. Cart or a conditional pre-checkout readiness step can show unresolved lines, offer/wait actions, and optional savings from alternate fulfillment. The checkout form should only receive lines that are ready to buy or ready to sell.
- The concept route was a design reference only and must not become a second live checkout path. It should be deleted from customer route composition for launch.
- Fresh-state cleanup needs concrete deletes, not compatibility migrations: old add-column schema patches, legacy Sell List receipt fallback reads, dense checkout copy, route tests for legacy behavior, and seed scenarios that imply old checkout contracts all need reset or removal.

## Surface Inventory

| Surface | Route IDs and paths | Primary files | Tests and evidence | Owning contexts |
| --- | --- | --- | --- | --- |
| Buy Cart review | `account-cart` at `/account/cart` | `bounded-contexts/checkout/routes/account-cart.tsx`; `bounded-contexts/checkout/features/cart/ui/cart-page.tsx`; cart API, domain, projection, and read-model files | `cart-page.test.tsx`; `cart/api/route.test.ts`; `catalog-projection.test.ts`; `checkout-routes.test.ts`; layout tests for guest/signed-in cart navigation | Checkout owns cart intent; Identity, Ordering, Payments, Marketplace supply, and Fulfillment provide previews |
| Checkout start and identity gateway | `checkout-start` at `/checkout/start` | `bounded-contexts/checkout/routes/checkout-start.tsx`; guest checkout request support | `checkout-routes.test.ts`; cookie-backed continuation doc | Checkout owns start session intent; Auth owns guest continuation and exit |
| Buy checkout session | `checkout-session` at `/checkout/:sessionId` | `bounded-contexts/checkout/routes/checkout-session.tsx`; `bounded-contexts/checkout/features/sessions/ui/checkout-page.tsx`; session API, domain, projection, and read model | `checkout-page.test.tsx`; `sessions/api/route.test.ts`; `sessions/domain/domain.test.ts`; `checkout-confirmation-support.test.ts` | Checkout owns review; Ordering creates purchases; Payments creates payment; Fulfillment/Tax/Identity provide quoted inputs |
| Guest payment handoff | `checkout-payment` at `/checkout/payments/:paymentId`; `guest-checkout-exit` at `/guest-checkout/exit` | `bounded-contexts/payments/routes/marketplace/checkout-payment.tsx`; Auth guest-exit route contribution; marketplace route composition | `checkout-payment-composition.test.ts`; `payments/tests/guest-payment-claim-action.test.ts`; layout guest checkout exit tests | Payments owns payment detail/recovery; Auth owns guest session exit |
| Signed-in payment handoff | `account-payment` at `/account/payments/:paymentId` | `bounded-contexts/payments/routes/marketplace/account-payment.tsx` | `checkout-payment-composition.test.ts`; payment handler tests | Payments owns payment and recovery |
| Sell List review | `account-sell-list` at `/account/sell-list` | `bounded-contexts/checkout/routes/account-sell-list.tsx`; `bounded-contexts/checkout/features/sell-list/ui/sell-list-page.tsx`; Sell List API, domain, projection, and read-model files | `sell-list-page.test.tsx`; `sell-list/api/route.test.ts`; `sell-list/domain/domain.test.ts`; `checkout-routes.test.ts` | Checkout owns seller intent and execution review; Marketplace owns offers/listings; Settlement owns payout readiness |
| Guest Sell List | `account-sell-list` guest branch | `account-sell-list.tsx`; guest Sell List API/runtime support | `checkout-routes.test.ts`; `sell-list/api/route.test.ts` | Checkout lets guests collect Sell List intent but execution requires a signed-in account |
| Checkout concept artifact | `checkout-concept` at `/checkout/concept` | Deleted route module and concept UI | Route composition test asserts it is absent | Checkout only; removed before launch |
| Marketplace shell | Top/bottom nav and guest checkout chrome | `deployables/marketplace/app/routes/layout.tsx` | `layout.test.tsx`; route composition test | Marketplace deployable composes Checkout, Auth, and Payments route contributions |
| API docs and OpenAPI | `/api/marketplace/account/cart`; `/checkout-sessions`; `/checkout/status`; `/checkout/recover`; `/purchases/checkout`; `/sell-list` | `docs/api/marketplace-api.md`; `docs/api/marketplace.openapi.json` | Documentation contract and generated API references | Checkout, Payments, Ordering, Marketplace |
| Localization | Checkout, cart, sessions, concept, Sell List copy | `contracts/localization/locales/en/checkout.ts` | UI and route tests assert current labels | Checkout copy with cross-context operational terms |
| Seeds and fixtures | Started cart checkout and demo cart lines | `bounded-contexts/checkout/support/runtime-support/seed.ts`; `bounded-contexts/checkout/support/seed-support/ids.ts` | local/staging seed usage; `chk_seed_started_cart` | Checkout seed support |

## Gap Table

| Target surface | Current state | Gap to Shopify-simple target | Milestone issues |
| --- | --- | --- | --- |
| Buy Cart | The cart has quantity controls, selected listing locks, product-level Smart Match settings, landed-cost preview, seller options, offer fallbacks, and a `Start checkout` CTA. | Keep cart editing simple. Move unresolved fulfillment and optional optimization into cart or a conditional readiness step. Do not carry "waiting for supply" or seller-selection work into checkout forms. | #1104, #1117, #1118, #1127 |
| Guest Buy Checkout | Guest flow starts at `/checkout/start`, then uses the dense session page and a separate payment route. It shows fulfillment preview, seller groups, payment quote state, wallet credit, package detail, and marketplace fee mechanics before payment. | Replace with a Shopify-like contact, delivery, shipping method, payment, and order summary flow. Keep mobile summary collapsible/sticky and hide marketplace internals unless a user decision is required. | #1101, #1105, #1112, #1119, #1127, #1134 |
| Signed-in Buy Checkout | Signed-in buyers use the same dense session page with some saved address and saved payment fast paths. | Show saved shipping and saved payment as compact editable rows, then use the same simple order review. Preserve the saved-payment trusted/off-session distinction in Payments, but keep it out of copy-heavy checkout chrome. | #1101, #1106, #1121, #1134 |
| Sell List | Sell List combines selected offers, product Smart Match offers, fallback listing creation, inventory selection, payout readiness, seller net, future listing gross, and execution in one surface. | Split list editing from execution readiness. The Sell List review should show item, condition, quantity, expected payout, and primary action. Offer acceptance, fallback listing creation, and inventory sourcing belong behind progressive disclosure or the conditional readiness step. | #1108, #1111, #1121, #1135 |
| Guest Sell Checkout | Guests can collect Sell List intent, but execution requires sign-in and payout readiness. | Keep guest Sell List as list-building only until the user signs in. If guest sell checkout is supported later, it must first route through account creation and readiness; it should not run as an anonymous payout flow. | #1109, #1111, #1121 |
| Signed-in Sell Checkout | Signed-in execution can accept offers, create fallback listings, record receipts, and show payout readiness inside the Sell List route. | Make account, payout, and ship-from readiness explicit before confirmation. The final sell checkout should look like a simple review/confirm surface, not an operations console. | #1110, #1111, #1121, #1128, #1135 |

## Unassigned Fulfillment Design

Unassigned fulfillment is not a checkout-form concern. The canonical flow should be:

1. Cart or Sell List captures intent.
2. A readiness check classifies each line as ready, unresolved, or unavailable.
3. If every line is ready, the user goes directly to checkout.
4. If any line is unresolved, the user stays in cart or lands on a conditional readiness step before checkout.
5. The readiness step can offer actions: pick a fulfillment source, let Chase Sets optimize, remove the line, place/wait for an offer, or continue with only ready lines.
6. If optimization can reduce cost, show a concise savings prompt such as "Save $X by switching fulfillment" with accept/keep-current actions.
7. Checkout receives only the final ready line set and displays no unresolved fulfillment controls.

The domain still needs fulfillment freshness, selected listing locks, supply state, package promises, and quote revisions. The user-facing checkout path should expose only the decision outcome, total impact, and delivery promise.

## Fresh-State Cleanup Table

| Area | Cleanup action | Rationale | Owning issues |
| --- | --- | --- | --- |
| Concept route | Delete `/checkout/concept` and its concept-only localization/UI once the real flow work begins. | Avoid shipping a second checkout entry point or preserving a compatibility design artifact. | #1112, #1132, #1116 |
| Session schema | Rebuild `checkout_session_pages` with final columns instead of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` compatibility patches. | Product is pre-launch; old session payload preservation is not needed. | #1132, #1100 |
| Cart schema | Rebuild `checkout_cart_line_pages` with final image, language, fulfillment, and availability columns in the base table. | Avoid migration leftovers and ambiguous old cart row shapes. | #1132, #1118 |
| Catalog projection schema | Fold checkout catalog language/i18n compatibility columns into the fresh base schema. | Remove compatibility layering from checkout-owned catalog projection data. | #1132 |
| Sell List receipts | Delete `checkout_sell_list_receipt_pages` and fallback reads from `read-model/queries.ts` once `checkout_sell_list_execution_receipt_pages` is canonical. | Legacy receipt fallback is a compatibility layer. | #1132, #1135 |
| Dense checkout session UI | Replace dense `CheckoutSessionPage` customer chrome with Shopify-simple contact/delivery/payment/order-summary sections. | Domain correctness can remain server-side without exposing mechanics. | #1101, #1105, #1106 |
| Dense cart UI | Simplify cart lines and move readiness/optimization to an explicit conditional panel or step. | Cart should not become a second checkout form. | #1104, #1117 |
| Dense Sell List UI | Simplify review and confirmation; move fallback listing and offer execution detail behind progressive disclosure or readiness. | Sell List checkout should not read like an execution console. | #1108, #1110, #1111 |
| Localization | Regenerate checkout copy keys around the new route map; remove dense labels such as package basis, raw fulfillment allocation, fee mechanics, and concept-only text. | Tests and UI should assert ideal copy, not old compatibility copy. | #1102, #1132 |
| API docs | Refresh cart, checkout-session, checkout status/recovery, purchases checkout, and Sell List docs around the canonical route map. | API docs currently document old sequencing and legacy endpoints. | #1100, #1130, #1132 |
| Tests | Delete or rewrite tests that assert dense marketplace-engine UI and old route composition. | Route tests should prove only the fresh-state paths are reachable. | #1115, #1132 |
| Seeds | Regenerate checkout seed data around simple guest buy, signed-in buy, signed-in sell, and readiness scenarios. | `chk_seed_started_cart` and existing demo cart sessions imply old checkout contracts. | #1118, #1132 |
| Operational runbooks | Keep money/postage/recovery runbook proof, but update smoke paths to the new UX. | Operations still need recovery and reconciliation; customers do not need legacy screens. | #1116, #1130 |

## Retain, But Hide From The Main Form

Retain these behaviors as domain or operational correctness:

- fulfillment preview revision freshness before confirmation
- seller allocation and selected listing locks
- unavailable supply and offer/wait behavior
- package, label, cutoff, and carrier promise rules
- tax/address restrictions and shipping quote validity
- marketplace checkout fee quote fingerprinting
- wallet/platform credit application
- saved payment trusted/off-session behavior
- guest checkout continuation and payment recovery
- payout readiness and seller net math
- order/payment/reconciliation evidence

Hide or move these from primary checkout chrome:

- Smart Match tuning controls
- raw seller group internals
- package plan tables
- signature/postage internal basis rows
- fulfillment preview revision language
- fee fingerprint/stale quote mechanics
- fallback listing execution details
- payout setup diagnostics unless blocking the sell action

## Sequencing Recommendation

1. Finish evidence and fresh-state gate work: #1099, #1133, #1132, #1103, #1112.
2. Lock contracts and fixtures: #1100, #1118, #1119, #1127, #1128, #1134.
3. Build readiness before checkout: #1117 for Buy Cart fulfillment assignment and optimization savings; #1111 for Sell List readiness.
4. Replace the main buy surfaces: #1104, #1105, #1106, #1101.
5. Replace sell surfaces: #1108, #1109, #1110.
6. Rebuild tests and docs as the fresh path becomes canonical: #1115, #1102.
7. Harden post-confirmation and operations: #1129, #1130, #1135, #1116.

## Risks To Carry Forward

- Payment: saved instruments, provider redirects, guest payment recovery, wallet credit, and fee quotes must remain correct while copy is simplified.
- Payout: Sell List confirmation must block or route to setup when payout readiness is incomplete.
- Shipping: readiness must prevent unassigned fulfillment from reaching checkout, but still show delivery promises and savings decisions clearly.
- Tax: address restrictions and tax estimates must be available before payment without turning checkout into an operations view.
- Fulfillment: fulfillment freshness cannot be weakened when internal preview details are removed from the UI.
- Settlement: seller net and payout timing must remain auditable after simplified sell checkout.
- Identity: guest buy checkout may remain supported; guest sell execution should require account readiness.
- Accessibility: mobile summary, sticky CTA, editable saved rows, and conditional readiness panels need keyboard and screen-reader coverage.
- Mobile layout: the Shopify-simple pattern depends on responsive order-summary placement and no overlapping sticky bars.
- Fresh-state cleanup: route and schema cleanup must happen before launch so old paths cannot reappear through tests or docs.

## Follow-Up Issue Review

No new milestone issue is required from this audit. The current milestone already has owners for the surfaced gaps:

- #1132 covers the fresh-state deletion/reset work and was updated with the cleanup targets above.
- #1117 covers unresolved Buy Cart fulfillment and optimization savings before checkout.
- #1111 covers Sell List readiness before seller checkout.
- #1115 covers route, API, and browser test rewrites.
- #1100 and #1118 cover contracts and fixture regeneration.
- #1130 and #1135 cover recovery, reconciliation, and post-confirmation outcomes.

If later implementation discovers a missing provider-specific payment, tax, shipping, or payout decision, open that as a narrow issue instead of broadening the customer checkout UI.
