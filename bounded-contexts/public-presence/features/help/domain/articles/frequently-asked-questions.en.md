---
slug: frequently-asked-questions
title: Frequently asked questions
description: Short answers about marketplace availability, seller fees, shipping, payouts, and order protection.
audience: buyer
category: getting-started
reviewedAt: "2026-07-12"
citedPolicies: ["commercial-terms.checkout-processing-fee", "settlement.clearance-window"]
relatedFlows: []
claimCategories: ["protection", "fees", "payouts", "shipping"]
promiseTable:
  - claim: Marketplace checkout is not open during prelaunch.
    issues: ["#4352"]
    tests: ["bounded-contexts/public-presence/features/waitlist/ui/public-pages.test.tsx"]
  - claim: Public launch is September 1, 2026, with beta invite waves beginning late July 2026.
    issues: ["#3952"]
    tests: ["bounded-contexts/public-presence/features/waitlist/ui/public-pages.test.tsx"]
  - claim: Published fees, checkout, and shipping promises reflect tested marketplace behavior.
    issues: ["#4352"]
    tests: ["bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx", "bounded-contexts/payments/features/payments/api/runtime.test.ts", "bounded-contexts/fulfillment/features/shipments/api/runtime.test.ts"]
  - claim: Seller funds release after recorded delivery plus the published clearance window.
    issues: ["#4287"]
    tests: ["bounded-contexts/settlement/features/wallets/read-model/queries.db.test.ts"]
---
## Is Chase Sets live yet?

Not yet. Chase Sets opens to everyone on September 1, 2026, and beta invite waves begin late July 2026. Join the waitlist for an invite before launch and founders offer eligibility.

## Where can sellers review fees?

The current [marketplace sales fee schedule](/sales-fees) explains the standard seller fee, per-item cap, listing-time fee locks, and the founders window. Buyers pay only payment processing at cost, shown before payment: {{policy:checkout-processing-fee.card.bps}} plus {{policy:checkout-processing-fee.card.fixed}} by card, {{policy:checkout-processing-fee.bank-account.bps}} plus {{policy:checkout-processing-fee.bank-account.fixed}} by bank account, and {{policy:checkout-processing-fee.platform-credit.bps}} plus {{policy:checkout-processing-fee.platform-credit.fixed}} with Chase Sets credit.

## How does shipping work?

Checkout shows the shipping method, estimate, items from the same seller, and any earned shipping allowance before payment. Sellers buy USPS labels in-product with tracking attached automatically; [Shipping requirements](/help/selling/shipping-requirements) covers evidence tiers, signature and insurance thresholds, and address handling.

## When do sellers get paid?

Sale proceeds stay pending until the order is delivered, then clear {{policy:settlement.clearance.base.days}} after delivery on the standard window or {{policy:settlement.clearance.extended.days}} on the extended window. [Getting paid](/help/selling/getting-paid) explains the windows, what pauses funds, and how payouts work.

## How are purchases protected?

Every order includes [Order protection](/help/buying/order-protection) — there is never a separate buyer protection fee. Order problems open structured support cases with stamped deadlines and automatic default remedies; [Refunds and returns](/help/buying/refunds-and-returns) covers cancellations, problem reports, and how return refunds release.
