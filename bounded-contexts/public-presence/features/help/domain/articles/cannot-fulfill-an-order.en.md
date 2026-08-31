---
slug: cannot-fulfill-an-order
title: When you cannot fulfill an order
description: How to release an order you cannot ship, what the buyer gets, and what it costs your wallet and standing.
audience: seller
category: selling
reviewedAt: "2026-07-13"
citedPolicies: []
relatedFlows: ["seller-cannot-fulfill"]
claimCategories: ["protection", "payouts"]
promiseTable:
  - claim: Before packing starts, a seller can cancel a paid sale self-service; the buyer receives a full refund and the cancellation is recorded in the seller cancellation rate.
    issues: ["#6453"]
    tests: ["bounded-contexts/ordering/features/orders/api/cancel-sale.db.test.ts", "bounded-contexts/ordering/features/orders/ui/order-detail-page.test.tsx", "bounded-contexts/payments/features/refunds/integrations/ordering/order-cancellation-refund-effect-projection.test.ts"]
  - claim: A seller who cannot fulfill an order raises an urgent support case that routes straight to support review without a buyer-seller negotiation.
    issues: ["#3722"]
    tests: ["bounded-contexts/platform-operations/features/support-requests/domain/domain.test.ts", "bounded-contexts/platform-operations/features/support-requests/api/runtime.test.ts"]
  - claim: A refund reverses the seller's share of the order proportionally along with the order's Order Protection contribution.
    issues: ["#3560"]
    tests: ["bounded-contexts/payments/features/refunds/api/runtime.test.ts", "bounded-contexts/payments/features/refunds/integrations/support/support-refund-effect-projection.test.ts"]
  - claim: New sale proceeds offset a negative wallet balance before entering the clearance pipeline.
    issues: ["#4534"]
    tests: ["bounded-contexts/settlement/features/wallets/domain/domain.test.ts", "bounded-contexts/settlement/features/wallets/integrations/payment-source/payment-source-projection.test.ts"]
---
## The honest move

Sometimes you cannot ship an order you accepted — the item sold elsewhere, it was damaged in storage, or it cannot be found. The right move is to say so quickly rather than let the order sit. Before packing starts, cancel the sale from its order detail. The buyer receives a full refund, and the cancellation is recorded in your seller cancellation rate.

After packing starts, raise it from the order as a cannot-fulfill case. Confirm that the order cannot be filled, and the case is created for you.

## What happens next

A cannot-fulfill case is urgent and goes straight to support review — there is no seller-response clock to wait out, because you have already given the answer. The default outcome is a full refund to the buyer. Because it routes directly to support, the buyer's refund and any inventory cleanup are not held up by messaging.

Reach for this flow only when the order genuinely cannot be shipped. If you can still ship but there is a label or tracking snag, use the shipping problem flow instead — see [Shipping requirements](/help/selling/shipping-requirements). If the buyer asked to call the order off, that is a cancellation, covered in [Refunds and returns](/help/buying/refunds-and-returns).

## What it costs you

A full refund reverses your share of the order proportionally, and the order's Order Protection contribution is reversed with it. If the proceeds had not yet cleared, the pending entry simply does not release. If they had already been paid out, the reversal draws against your wallet and can push the balance negative.

A negative balance is not a penalty on its own: your next sale proceeds offset it first, before anything enters the normal clearance pipeline, and payout requests pause until the wallet recovers. See [Getting paid](/help/selling/getting-paid) for how holds and negative balances interact with payouts.

## Keep it rare

Cannot-fulfill cases are the cleanest way out of an order you cannot ship, but they are a fulfillment failure, and repeated failures weigh on your seller standing and the trust signals that shorten your clearance window. The durable fix is keeping listed quantities in step with what you actually hold. See [Shipping requirements](/help/selling/shipping-requirements) for how committing to ship starts the clock the platform measures you against.
