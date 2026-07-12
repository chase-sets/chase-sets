---
slug: frequently-asked-questions
title: Frequently asked questions
description: Short answers about marketplace availability, seller fees, shipping, and order protection.
audience: buyer
category: getting-started
revisionDate: "2026-07-12"
citedPolicies: []
relatedFlows: []
promiseTable:
  - claim: Marketplace checkout is not open during prelaunch.
    issues: ["#4352"]
    tests: ["bounded-contexts/public-presence/features/waitlist/ui/public-pages.test.tsx"]
  - claim: Published fees, checkout, and shipping promises reflect tested marketplace behavior.
    issues: ["#4352"]
    tests: ["bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx", "bounded-contexts/payments/features/payments/api/runtime.test.ts", "bounded-contexts/fulfillment/features/shipments/api/runtime.test.ts"]
---
## Is Chase Sets live yet?

Chase Sets is not open for marketplace checkout yet. Request access to tell us whether buying, selling, or both matters most for your account.

## Where can sellers review fees?

The current [marketplace sales fee schedule](/sales-fees) explains the standard seller fee, per-item cap, and listing-time fee confirmation. Buyers see any checkout fee before payment.

## How does shipping work?

Checkout shows the shipping method, estimate, items from the same seller, and any earned shipping allowance before payment. Sellers see the applicable shipping allowance before accepting an order.

## How are purchases protected?

Before payment, checkout shows item details, seller profile, shipping, return options, and support coverage. After purchase, support reviews tracking, payment status, listing evidence, and account context.
