---
slug: sales-fees
path: /sales-fees
title: Marketplace sales and checkout fees
description: See the live standard sales-fee schedule and buyer checkout processing fees before you transact.
audience: seller
category: selling
revisionDate: "2026-07-12"
citedPolicies: ["commercial-terms.marketplace-sales-fee-schedule", "commercial-terms.checkout-processing-fee"]
relatedFlows: ["listing-confirmation", "checkout-price-breakdown"]
promiseTable:
  - claim: Published fee figures resolve from the current ratified policy documents.
    issues: ["#4353"]
    tests: ["bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx"]
---
## One standard sales fee

Personal, business, and enterprise accounts all use the same standard schedule: {{policy:marketplace-sales-fee.standard.bps}} of the item price plus {{policy:marketplace-sales-fee.standard.fixed}}, capped at {{policy:marketplace-sales-fee.standard.cap}} per item.

There is no separate listing fee. You see the applicable sales fee before confirming a listing, and the locked amount does not change for that transaction if the published schedule is revised later.

## Checkout processing fees

Buyers see the applicable checkout fee before payment. The current processing rates are:

- Card: {{policy:checkout-processing-fee.card.bps}} plus {{policy:checkout-processing-fee.card.fixed}}
- Bank account: {{policy:checkout-processing-fee.bank-account.bps}} plus {{policy:checkout-processing-fee.bank-account.fixed}}
- Chase Sets credit: {{policy:checkout-processing-fee.platform-credit.bps}} plus {{policy:checkout-processing-fee.platform-credit.fixed}}

## When policy values change

This page reads the effective policy values when it renders and refreshes within six minutes. If a scheduled revision is within 30 days, the page shows its effective date before the change takes effect.
