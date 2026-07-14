---
slug: refunds-and-returns
title: Refunds and returns
description: How cancellations, order problems, returns, and refunds work — what each side provides and what happens on the deadlines.
audience: buyer
category: buying
reviewedAt: "2026-07-13"
citedPolicies: ["platform-operations.support-deadlines"]
relatedFlows: ["return-request", "buyer-cancel-request", "product-not-received", "product-damaged", "wrong-product-received", "missing-products", "refund-status"]
claimCategories: ["protection", "shipping"]
promiseTable:
  - claim: Refunds are issued only through order cancellation, support-flow resolutions, or platform fraud safeguards, always to the original payment and capped at the remaining refundable amount.
    issues: ["#3560"]
    tests: ["bounded-contexts/payments/features/payments/domain/domain.test.ts", "bounded-contexts/payments/features/refunds/api/runtime.test.ts"]
  - claim: A buyer can cancel self-service until packing starts, and a captured payment is refunded including the order's checkout-fee share even when capture lands after cancellation.
    issues: ["#3557"]
    tests: ["bounded-contexts/ordering/features/orders/api/runtime-order-lifecycle.test.ts", "bounded-contexts/payments/features/refunds/integrations/ordering/order-cancellation-refund-effect-projection.test.ts"]
  - claim: Order problems run through structured support flows with evidence checklists, stamped response deadlines, and default remedies applied on seller silence.
    issues: ["#3722", "#4288"]
    tests: ["bounded-contexts/platform-operations/features/support-requests/domain/domain.test.ts", "bounded-contexts/platform-operations/features/support-requests/api/runtime.test.ts"]
  - claim: Return refunds require completed return evidence, are gated on return delivery, and release after the inspection window unless the seller disputes condition; high-value returns require support review.
    issues: ["#4248"]
    tests: ["bounded-contexts/platform-operations/features/support-requests/domain/domain.test.ts", "bounded-contexts/payments/features/refunds/integrations/support/support-refund-effect-projection.test.ts"]
---
## Current availability

Marketplace checkout opens at launch. Until then, the public site does not create purchases, charges, refunds, or returns.

## Where refunds come from

There is no ad-hoc refund button on either side. A refund is created by one of three things: an order cancellation, the resolution of a support request, or a platform fraud safeguard. Every refund goes back to the original payment, and no combination of refunds can exceed what was actually paid.

## Cancelling an order

Before payment completes, a buyer or seller can cancel and nothing is charged. After payment, a buyer can still cancel self-service until the seller starts packing; the refund covers the order total plus the order's share of the checkout fee, and this holds even if the payment capture lands after the cancellation. Once packing has started, cancellation becomes a request the seller confirms — and if the seller does not respond within {{policy:support-deadlines.buyer-cancel-request.seller-response.hours}}, the cancellation is confirmed automatically.

A seller who cannot fulfill an order raises it as an urgent support case whose default outcome is a full refund to the buyer.

## Reporting a problem with an order

Order problems are structured flows opened from the order: product not received, product not as described, product arrived damaged, wrong product received, missing products, and authenticity concern. Each flow captures specific evidence up front — photos and condition notes for condition issues, package photos for damage, the missing quantity for shortages — and gives the seller a set of structured responses such as accepting a return, offering a partial refund or replacement, or challenging with evidence.

The seller's response deadline is stamped when the case opens; for most flows it is {{policy:support-deadlines.product-not-received.seller-response.hours}}. If the seller does not respond in time, the flow's default remedy applies automatically: a full refund when delivery cannot be proven, a return for refund for condition issues, a replacement for a wrong product. Contested cases and cases needing a calculated amount go to support review instead, with its own stamped deadline of {{policy:support-deadlines.product-not-received.support-review.hours}} for most flows. Authenticity concerns go straight to support review as urgent cases.

## Returns

A return starts as a return request on the order. The buyer selects a reason and provides photos of the item as received plus condition notes before any refund can be resolved. If the seller accepts — or does not respond within {{policy:support-deadlines.return-request.seller-response.hours}} while the evidence checklist is complete — the case resolves as a return for refund.

The refund itself is gated on the return: it is held until return delivery is confirmed, then a five-day inspection window runs. If the seller says nothing, the refund releases automatically; if the seller disputes the returned item's condition within the window, the case converts to a support investigation and only support can release the refund. Returns on orders of $250 or more always require support review before the refund releases.

## What refunds do on the seller side

A refund reverses the seller's share of the order proportionally, and the order's Order Protection contribution is reversed with it. Open cases also hold the order's funds — see [Getting paid](/help/selling/getting-paid) for how holds interact with payouts.

## Support

For questions about a refund in progress, open a refund-status request from the order or contact support@chasesets.com.
