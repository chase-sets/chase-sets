---
slug: payment-problems
title: Payment problems
description: What to do about a declined payment, a charge you do not recognize, a wrong or duplicate charge, and how payment issues are handled.
audience: buyer
category: buying
reviewedAt: "2026-07-13"
citedPolicies: []
relatedFlows: ["payment-problem"]
claimCategories: ["protection"]
promiseTable:
  - claim: Refunds are always returned to the original payment and can never exceed the amount actually paid.
    issues: ["#3560"]
    tests: ["bounded-contexts/payments/features/payments/domain/domain.test.ts", "bounded-contexts/payments/features/refunds/api/runtime.test.ts"]
  - claim: Order problems open structured support cases that stamp a response deadline at open time and route to support when they need review.
    issues: ["#3722", "#4288"]
    tests: ["bounded-contexts/platform-operations/features/support-requests/domain/domain.test.ts", "bounded-contexts/platform-operations/features/support-requests/api/runtime.test.ts"]
---
## Before you open a request

Marketplace checkout opens at launch. Until then, the public site does not create purchases or charges, so there is nothing to dispute yet.

Once checkout is live, your final total is always shown before you confirm, and card payments may ask for an extra verification step from your bank before the charge completes. If a charge did not go through, it usually means that verification was not finished or your bank declined it — retrying checkout is the fastest fix, and no money moves until a charge actually completes.

## When to raise a payment problem

Open a payment problem from the order when something is wrong with the money itself rather than the item:

- A charge you do not recognize.
- A charge for the wrong amount.
- What looks like a duplicate charge for one order.
- A refund that has not arrived.

If your issue is instead about the item — it never arrived, arrived damaged, or is not as described — use the matching order problem instead. See [Refunds and returns](/help/buying/refunds-and-returns).

## What to include

A payment problem asks you to attach the charge reference or the payment error you saw, plus a refund reference if your question is about a refund. Those details let support and the payment team trace the exact charge without a back-and-forth.

## How it is handled

A payment problem is an urgent case that goes straight to support and the payment team — it does not wait on the seller, because the seller does not control the charge. Payments and refunds run through the payment provider, so support works from the provider's record of your charge rather than a manual guess.

Every refund is returned to the original payment method and is capped at what was actually paid; there is no way for refunds to add up to more than your charge. Card holds that never became a completed charge are released by your bank on its own schedule.

## Recognizing a real charge

Chase Sets charges appear against the order you placed. If a bank statement shows a charge with no matching order in your account, open a payment problem with the charge reference so support can confirm whether it belongs to Chase Sets at all. For anything that looks like account fraud, also reach support@chasesets.com.

## Related

- [Order protection](/help/buying/order-protection) explains how payments, disputes, and chargebacks are handled.
- [Refunds and returns](/help/buying/refunds-and-returns) covers where refunds come from and how returns release.
