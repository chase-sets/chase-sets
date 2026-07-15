---
slug: order-protection
title: Order protection
description: How Chase Sets applies buyer and seller safeguards around payment, fulfillment, disputes, returns, payout release, and negative balances.
audience: buyer
category: buying
reviewedAt: "2026-07-14"
citedPolicies: ["platform-operations.support-deadlines", "platform-operations.platform-remedies"]
relatedFlows: ["product-not-received", "product-not-as-described", "authenticity-concern"]
claimCategories: ["protection", "payouts", "shipping"]
promiseTable:
  - claim: Order problems open structured support cases that stamp response deadlines at open time and apply default remedies on seller silence.
    issues: ["#3722", "#4288"]
    tests: ["bounded-contexts/platform-operations/features/support-requests/domain/domain.test.ts", "bounded-contexts/platform-operations/features/support-requests/api/runtime.test.ts"]
  - claim: Every order includes a 1% Order Protection reserve contribution without a separate buyer fee line.
    issues: ["#4098"]
    tests: ["bounded-contexts/ordering/features/orders/domain/policies.test.ts", "bounded-contexts/settlement/features/wallets/integrations/payment-source/payment-source-projection.test.ts"]
  - claim: Payment risk, disputes, refunds, and evidence follow provider-backed workflows.
    issues: ["#4352"]
    tests: ["bounded-contexts/payments/features/payments/api/runtime.test.ts", "bounded-contexts/payments/features/refunds/api/runtime.test.ts"]
  - claim: Shipment outcomes and payout holds are durable marketplace records.
    issues: ["#4352"]
    tests: ["bounded-contexts/fulfillment/features/shipments/api/runtime.test.ts", "bounded-contexts/settlement/features/payouts/api/runtime.test.ts"]
  - claim: Platform-covered resolution copy shows the approved remedy and allocation without implying seller fault or exposing internal funding details.
    issues: ["#5222"]
    tests: ["bounded-contexts/platform-operations/features/support-requests/ui/customer-remedy-status.test.tsx"]
---
## Protected payment

Every order includes Order Protection. One percent of the item subtotal, rounded up to the nearest cent, is contributed to the protection reserve. The seller-funded shipping allowance covers Order Protection first and shipping second; buyers see only any combined overflow as Shipping, never as a separate protection fee.

Payments run through provider-backed checkout flows with final totals visible before confirmation. Card payments may request risk-based 3DS step-up; liability-shift facts inform payment risk and dispute posture, but they do not override Settlement payout-release rules.

## Order visibility

Checkout and order views keep product, seller, item price, one Shipping amount, checkout fee, and fulfillment status visible. Order Protection is described as included and is never itemized as a buyer fee. Seller payout detail itemizes the shipping allowance and Order Protection. Seller sale proceeds stay pending until delivery, risk, support, and aging rules clear.

## Fraud signals

Early fraud warnings and processor fraud reviews are recorded against the Payment. If an early fraud warning arrives on a captured payment that is not already disputed, the current runtime attempts a refund for the remaining refundable amount when the refund service is configured.

## Getting help with an order

If an order never arrives or the item is not as described, damaged, wrong, or missing, you open a structured support case directly from the order. Each case captures the evidence support needs — photos, condition notes, quantities — and stamps the seller's response deadline the moment it opens; for most flows that deadline is {{policy:support-deadlines.product-not-received.seller-response.hours}}. If the seller does not respond in time, the flow's default remedy applies automatically: when delivery cannot be proven on a product-not-received case, that remedy is a full refund. Cases that need review go to support with a stamped deadline of their own, and authenticity concerns route to support immediately as urgent. See [Refunds and returns](/help/buying/refunds-and-returns) for each flow in detail.

## Platform-covered resolutions

When the available evidence does not establish responsibility with enough confidence, Chase Sets may choose at its discretion to cover all or part of a resolution. This is not insurance and does not promise coverage for another case. The support case shows the approved buyer remedy, the seller allocation, the amount Chase Sets is covering, the return destination, the refund trigger, and the next action.

A fully platform-covered resolution shows a seller allocation of $0.00; a split resolution shows both amounts in the remedy currency. Platform coverage does not by itself establish seller or buyer fault. Internal funding balances, approval limits, provider identifiers, and the other party's evidence are not shown.

Follow the return destination and deadline in the support case. Delivery to Chase Sets transfers custody, not ownership by itself; the case instructions state whether ownership changes or whether the item may be inspected, retained, returned, recovered, or disposed of as part of the resolution. Missing a required return deadline can pause or change the remedy.

Refund release follows the trigger shown in the case: immediately after authorization, after carrier acceptance, after delivery, after Chase Sets intake, or after an explicit support release. External payment and carrier timing is shown only when a reliable date is available. If a return or refund fails, follow the recovery instructions in the case or contact support@chasesets.com for escalation.

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
