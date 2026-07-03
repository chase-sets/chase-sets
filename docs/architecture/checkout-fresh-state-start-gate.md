# Checkout Fresh-State Start Gate

The Checkout fresh-state rebuild shipped as the Shopify-simple Buy Cart and Sell List flow. This document now records the live ownership map, durable readiness rules, and evidence trail for the shipped system so future changes keep the customer path simple while preserving bounded-context ownership underneath. The main launch evidence lives on the closed milestone #33 epic, [#1850](https://github.com/chase-sets/chase-sets/issues/1850), which closed on 2026-06-16 after the June checkout rebuild and follow-up remediation.

## Scope

The target flow is:

1. Review a Buy Cart or Sell List.
2. Resolve conditional readiness before checkout.
3. Enter the simple checkout form only after the cart/list can create a checkout-ready session.
4. Confirm payment, sale, payout, label, or order commitments through context-owned commands.
5. Land on confirmation and account/history handoff surfaces.

The marketplace launched this checkout surface as fresh-state only. There is no customer migration, old checkout link support, old checkout session compatibility, dense checkout fallback, dual-write preservation, or compatibility shim for pre-launch checkout data.

## Review Findings

- Issue #1133 established the original ownership and dependency map. The live system keeps that map as a maintenance constraint: follow-up checkout work should not split buy, sell, provider, and support behavior into disconnected slices.
- Fulfillment assignment remains the most important product boundary. Checkout must not become the place where customers resolve unassigned seller allocation. That resolution belongs in the cart or in a conditional pre-checkout readiness step.
- The bounded-context ownership map below ties Checkout orchestration to Marketplace, Ordering, Payments, Settlement, Fulfillment, Identity, Tax, Notifications, Support, and Platform Operations.
- Provider configuration and proof work stay upstream of contract and state-machine changes. Checkout UI changes that touch payment, payout, shipping, tax, notification, or support rails need provider or mocked-provider evidence in the owning context.
- The first vertical slice proved one buy path and one sell path together. Future expansions should preserve that shared shell, readiness model, provider handoff, confirmation copy, and account/history handoff behavior.

## Ownership Matrix

| Concern | Owning context | Checkout role |
| --- | --- | --- |
| Buy Cart, Sell List, source intent, checkout session, readiness orchestration, checkout routes | Checkout | Owns the active pre-commitment workflow and customer-visible session state. |
| Listings, offers, seller listing availability, offer matches, listing visibility | Marketplace | Publishes source supply/demand facts that Checkout can use; does not own durable cart/list execution state. |
| Order, purchase, sale, order split, order economics snapshot, postage policy snapshot | Ordering | Receives checkout confirmation requests and creates committed orders; Checkout does not own committed order state. |
| Payment intent, capture, refund, saved checkout instrument readiness, marketplace checkout fee quote | Payments | Supplies payment readiness and provider handoff; Checkout never receives raw card or bank details. |
| Wallet, ledger entries, payout readiness, connected payout account, payout release holds, payouts | Settlement | Supplies seller payout readiness and wallet credit facts; Checkout does not own internal financial truth. |
| Shipment, ship-from location, package preparation, labels, tracking, dispatch, delivery, exceptions | Fulfillment | Executes shipment facts after Ordering marks orders ready; Checkout can show readiness summaries only. |
| User, Account, Membership, Contact Method, Shipping Address, Consent | Identity | Supplies actor/account, reusable destination, contact, and consent facts; Checkout snapshots selected values. |
| Sales tax quote contracts and nexus readiness | Tax | Supplies provider-agnostic quote posture through Ordering; Checkout shows customer-safe tax state. |
| Notification Center, notification preferences, delivery policy | Notifications | Delivers customer communication policy from source-context facts. |
| Structured support requests and operator recovery | Support | Owns recovery workflows after source-context self-service rules end. |
| Provider credentials, webhook ingress, proof mode, deployment gates | Platform Operations | Wires Stripe, EasyPost, SES/SNS, tax provider posture, environment secrets, and promotion gates. |

## Fulfillment Readiness Rule

Checkout can only start when the Buy Cart or Sell List can produce a checkout-ready session. Every payable item must have either:

- a valid fulfillment path or allocation,
- an accepted customer-level alternate allocation,
- an explicit unavailable state that keeps the item out of checkout, or
- a save-for-later state that keeps the item in cart/list but outside the payable session.

Unassigned fulfillment is resolved before checkout:

1. Customer reviews cart/list.
2. Customer selects checkout.
3. Checkout runs readiness over the cart/list state.
4. If all lines are ready and no meaningful optimization exists, Checkout creates or resumes the checkout session.
5. If any line lacks fulfillment assignment, the customer sees a cart-adjacent or pre-checkout readiness step.
6. If an alternate allocation saves money, the customer may accept the optimization before checkout or decline when the current allocation is still valid.
7. If no valid allocation exists, the customer can remove the item, save it for later, or wait for supply. The main checkout form is never shown for that unresolved item.

The readiness UI must stay customer-safe. It can describe item availability, shipping/fulfillment impact, savings, and seller grouping at a high level. It must not expose internal seller-allocation machinery.

## Dependency Order

The shipped dependency path was:

1. Start gate: #1133 established ownership, dependency sequence, signoff, non-goals, and launch evidence mapping.
2. Audit and cleanup: #1099 audited current surfaces; #1132 removed legacy checkout compatibility, dense routes, fixtures, data patterns, and fallback assumptions.
3. Route and lifecycle foundation: #1103 defined fresh routes and route disposition; #1118 defined anonymous/signed-in cart, sell-list, guest merge, session recovery, and expiration.
4. Contracts and readiness: #1100 defined buy/sell session contracts; #1117 defined fulfillment readiness and optimization before checkout; #1119 defined freshness, availability, reservation, and estimate guards.
5. Provider and policy readiness: #1134 configured credentials, webhooks, and sandbox proof; #1124 covered security/privacy/legal; #1128 covered discounts, credits, fees, gift cards, and promotions; #1127 covered address validation and serviceability.
6. Visual target and shell: #1112 finalized visual targets; #1101 built shared design-system primitives; #1102 normalized copy and progressive disclosure.
7. Buy implementation: #1104 replaced Buy Cart review; #1105 implemented guest buy checkout; #1106 implemented signed-in buy checkout; #1107 wired totals, tax, payment, and order creation.
8. Sell implementation: #1108 replaced Sell List review; #1109 covered guest sell checkout posture; #1110 implemented signed-in sell checkout; #1111 wired payout, label, condition review, and settlement contracts.
9. Cross-flow hardening: #1113 integrated accelerated/saved payment and payout setup affordances; #1121 integrated saved addresses/contact preferences/seller readiness; #1131 added risk controls; #1130 added reconciliation; #1129 added transactional communication.
10. Confirmation and account handoff: #1120 added receipts and next steps; #1135 linked orders, sales, shipments, payment, payout, support, and account history surfaces.
11. Evidence and launch: #1114 observability, #1123 performance, #1115 e2e/visual/a11y, and #1116 fresh-state launch smoke and final legacy deletion.

## First Vertical Slice

The first vertical slice must prove both sides of the composite flow:

| Path | Required proof |
| --- | --- |
| Buy | Guest Buy Cart with checkout-ready fulfillment allocation, contact and delivery entry, shipping method selection, payment provider sandbox success, order creation, buyer confirmation, guest receipt or account-history handoff. |
| Sell | Signed-in Sell List with saved or validated ship-from readiness, payout readiness, condition/verification review, label or label-readiness provider sandbox proof, sale confirmation, seller sale detail, shipment handoff, and payout/account history handoff. |

Guest sell checkout remains a product option, but signed-in sell was the lower-risk first proof because payout readiness and seller fulfillment setup are account-owned operational concerns.

## Capability Decisions

| Capability | Start-gate decision |
| --- | --- |
| Promo codes | Deferred unless #1128 approves a fresh-state contract and launch evidence. UI must not reserve a promo field by default. |
| Gift cards | Deferred unless #1128 defines ownership, accounting, refund, and legal posture. |
| Wallet credit | Supported only through Settlement-owned available balance facts and Payments-owned payment application rules. |
| Marketplace checkout fee | Supported through Payments-owned fee quote and stale quote guards. |
| Accelerated checkout | Allowed after baseline checkout works; #1113 owns saved payment, accelerated payment, and payout setup affordances. |
| Saved payment instruments | Payments-owned readiness metadata only; Checkout renders labels and selected category without raw provider references. |
| Guest account claim | Allowed as a post-confirmation or receipt recovery path only when #1118, #1129, and #1135 define recovery, communication, and account-history handoff. |
| Seller payout setup | Settlement-owned readiness and provider-managed setup. Checkout may link to or embed setup only through #1113/#1121 contracts. |
| Optimization savings | Allowed before checkout through #1117 when it is customer-safe, optional for valid allocations, and never resolved inside the checkout form. |
| AP2/headless checkout | Not launch-ready by default. UCP flows use trusted UI handoff unless Payments has approved verifier/provider support. |

## Change Review Gates

Checkout changes after the shipped rebuild should preserve:

- Product clarity for first-slice buy and sell paths, guest account claim posture, and deferred capability decisions.
- Design-system-owned desktop, mobile, guest, signed-in, buy, sell, readiness, optimization, confirmation, and error states.
- Engineering ownership across context boundaries, route strategy, contract shape, and fresh-state-only cleanup scope.
- Security/privacy/legal posture for payment, payout, tax, stored credential, guest receipt, communication, and data retention.
- Operations evidence for provider sandbox/proof, webhook destinations, launch smoke, support recovery, and rollback posture.
- QA evidence for visual, mobile, accessibility, e2e, freshness, provider failure, reconciliation, and performance coverage.

## Launch Evidence Index

| Evidence gate | Primary issues |
| --- | --- |
| Start-gate ownership and dependency map | #1133 |
| Current-state audit and target comparison | #1099 |
| Fresh-state cleanup and no-compatibility proof | #1132, #1116 |
| Route strategy and old-route disposition | #1103, #1116 |
| Shared contracts and lifecycle | #1100, #1118 |
| Fulfillment readiness and optimization before checkout | #1117, #1119 |
| Visual targets, shell, copy, and progressive disclosure | #1112, #1101, #1102 |
| Buy cart and buy checkout | #1104, #1105, #1106, #1107 |
| Sell list and sell checkout | #1108, #1109, #1110, #1111 |
| Provider credentials, webhooks, sandbox proof | #1134 |
| Saved info, saved payment, payout setup, account readiness | #1113, #1121 |
| Address, delivery, shipping restriction, and tax posture | #1127, #1124, #1134 |
| Discounts, credits, fees, gift cards, promotions | #1128 |
| Availability, reservations, stale facts, risk | #1119, #1131 |
| Confirmation, account history, fulfillment handoff | #1120, #1135 |
| Notifications and customer communications | #1129 |
| Payment/order/label/payout/notification reconciliation | #1130 |
| Support/operator recovery | #1122 |
| Observability, performance, test coverage | #1114, #1123, #1115 |

## Verification Expectations

Follow-up PRs that change this checkout flow should cite the relevant rows from this document and include:

- the owning bounded contexts touched,
- the issue dependencies unblocked or consumed,
- explicit fresh-state cleanup or no-legacy evidence when applicable,
- tests for ready, unresolved, stale, provider-failed, recovered, and confirmed states where relevant,
- customer-safe copy evidence for readiness, optimization, unavailable, and recovery states,
- mobile and desktop visual evidence for any user-facing route,
- provider proof or mocked-provider contract evidence when external rails are involved.
