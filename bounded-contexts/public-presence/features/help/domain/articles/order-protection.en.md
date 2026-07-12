---
slug: order-protection
title: Order protection
description: How Chase Sets applies buyer and seller safeguards around payment, fulfillment, disputes, returns, payout release, and negative balances.
audience: buyer
category: buying
reviewedAt: "2026-07-12"
citedPolicies: []
relatedFlows: []
claimCategories: ["protection", "payouts", "shipping"]
promiseTable:
  - claim: Payment risk, disputes, refunds, and evidence follow provider-backed workflows.
    issues: ["#4352"]
    tests: ["bounded-contexts/payments/features/payments/api/runtime.test.ts", "bounded-contexts/payments/features/refunds/api/runtime.test.ts"]
  - claim: Shipment outcomes and payout holds are durable marketplace records.
    issues: ["#4352"]
    tests: ["bounded-contexts/fulfillment/features/shipments/api/runtime.test.ts", "bounded-contexts/settlement/features/payouts/api/runtime.test.ts"]
---
## Protected payment

Payments run through provider-backed checkout flows with final totals visible before confirmation. Card payments may request risk-based 3DS step-up; liability-shift facts inform payment risk and dispute posture, but they do not override Settlement payout-release rules.

## Order visibility

Checkout and order views keep product, seller, item price, shipping, shipping credit, checkout fee, protection, and fulfillment status visible. Seller sale proceeds and shipping allowances stay pending until delivery, risk, support, and aging rules clear.

## Fraud signals

Early fraud warnings and processor fraud reviews are recorded against the Payment. If an early fraud warning arrives on a captured payment that is not already disputed, the current runtime attempts a refund for the remaining refundable amount when the refund service is configured.

## Chargebacks and disputes

When the payment processor reports a dispute or chargeback, Payments records the processor dispute id, lifecycle state, evidence deadline, charge reference, affected orders, and seller payout exposure. Settlement then holds pending seller funds, claws back released seller exposure when needed, and releases a chargeback hold only when the processor dispute is won.

## Dispute evidence

Payments assembles dispute evidence from Chase Sets order records and Fulfillment shipment evidence. Evidence is submitted to the processor only when tracking proof is available; when no tracking proof exists, Payments records that evidence was unavailable instead of inventing proof.

## Shipping evidence tiers

Shipping evidence is set from the committed package plan. Current tiers are untracked letter mail, tracked parcel, signature-confirmed shipment, and carrier-insured shipment. Priority and higher-value shipments can require stronger signature or insurance evidence under the applicable shipping policy.

## Returns and shipment exceptions

Fulfillment records delivery, return-to-sender, carrier exceptions, and return outcomes from shipment and postage-provider events. Return and exception evidence can extend seller payout release and gives support a concrete order and shipment record to review.

## Negative balances

If chargebacks, refunds, or payout recovery obligations exceed an account's available wallet balance, Settlement records a negative balance. New sale proceeds and shipping allowances offset that balance before any remaining funds enter normal payout release. Accounts at or beyond the configured collections threshold for the configured grace period move to collections, which pauses new listing availability and payout requests until the wallet returns to good standing.
