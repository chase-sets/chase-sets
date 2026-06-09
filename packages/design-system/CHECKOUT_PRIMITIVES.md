# Checkout Primitives

The checkout primitives provide the shared Shopify-simple structure for buy and sell checkout surfaces while staying domain-light.

Use these primitives for:

- desktop checkout shells with the form/list review on the left and summary on the right;
- mobile checkout shells with a collapsible summary before the form;
- sticky mobile total and primary action bars;
- order or sell-list summary rows with thumbnail, quantity badge, variant facts, and price;
- signed-in saved-info rows such as `Ship to`, `Ship from`, `Shipping`, `Payment`, or `Payout`;
- express/wallet action slots;
- concise readiness, changed economics, invalid address, risk, stale session, reconciliation, and confirmation states.

Checkout business rules stay in the Checkout bounded context. These primitives should receive customer-safe facts that are already resolved by cart, sell list, readiness, session, payment, payout, fulfillment, or support logic.

## Fresh-State Rules

- Do not use checkout primitives to expose seller allocation, fulfillment assignment, provider diagnostics, or settlement internals in the main checkout form.
- Unresolved fulfillment and optional optimization belong in cart or a conditional pre-checkout readiness step.
- Checkout session screens should consume a validated readiness snapshot and present concise recovery if the snapshot becomes stale.
- Dense marketplace-engine copy should stay out of the customer-facing checkout path.
