---
slug: getting-paid
title: Getting paid
description: When sale proceeds become available, what the clearance window depends on, what pauses funds, and how payouts work.
audience: seller
category: selling
reviewedAt: "2026-07-12"
citedPolicies: ["settlement.clearance-window", "settlement.payout-bounds"]
relatedFlows: ["refund-status"]
claimCategories: ["payouts", "protection"]
promiseTable:
  - claim: Sale proceeds and shipping payouts stay pending until delivery is recorded and the clearance window has passed; there is no release without a recorded delivery.
    issues: ["#4287"]
    tests: ["bounded-contexts/settlement/features/wallets/read-model/queries.db.test.ts", "bounded-contexts/settlement/features/wallets/integrations/fulfillment-source/fulfillment-source-projection.test.ts"]
  - claim: Open support requests, fraud reviews, and chargebacks hold seller funds, and a chargeback hold releases only when the dispute is won.
    issues: ["#4491", "#4499"]
    tests: ["bounded-contexts/settlement/features/wallets/integrations/support-source/support-source-projection.test.ts", "bounded-contexts/settlement/features/wallets/integrations/payment-source/payment-source-projection.test.ts"]
  - claim: Payout requests are validated against the published bounds, the available balance, support holds, negative balances, and payout setup, with failed payouts returned to the wallet.
    issues: ["#4287", "#4570"]
    tests: ["bounded-contexts/settlement/features/payouts/api/runtime.test.ts", "bounded-contexts/settlement/features/payouts/domain/payout-policy.test.ts"]
  - claim: New sale proceeds offset a negative balance before entering the clearance pipeline.
    issues: ["#4534"]
    tests: ["bounded-contexts/settlement/features/wallets/integrations/payment-source/payment-source-projection.test.ts", "bounded-contexts/settlement/features/wallets/domain/domain.test.ts"]
---
## Pending, then available

When a buyer's payment is captured, your money posts to your Chase Sets wallet as pending: one entry for the item proceeds and, when the order carries one, a separate entry for your shipping payout. Pending funds become available automatically once the order is delivered and the clearance window has passed. Both entries release on the same schedule.

Delivery is the gate. Release requires a recorded carrier delivery for the order, so shipping with tracking through the platform is what starts the clock — see [Shipping requirements](/help/selling/shipping-requirements). An order with no recorded delivery does not release, no matter how much time passes.

## The clearance window

Two windows exist today: a standard window of {{policy:settlement.clearance.base.days}} after delivery and an extended window of {{policy:settlement.clearance.extended.days}} after delivery.

The standard window applies when everything about the sale checks out: the platform has marked your account a trusted seller, your account has at least one eligible review, no risk signals are linked to your account, the order qualifies for trust signals, and the sale is under {{policy:settlement.clearance.high-value-threshold}}. If any of those conditions is not met — including every sale at or above {{policy:settlement.clearance.high-value-threshold}}, and all sales while your account is new — the extended window applies instead.

These are the current published values; this page reads them live from the platform policy.

## What pauses funds

Some events hold your funds beyond the normal schedule:

- An open support request on an order holds that order's funds until the request is resolved, and refund-shaped resolutions keep the hold for the refund.
- Payment fraud reviews and early fraud warnings hold funds while they are reviewed.
- A chargeback holds the disputed order's funds and releases them only if the dispute is won. When a chargeback arrives after funds were released, the disputed amount is recovered from your balance.

Held amounts are excluded from what you can pay out, and orders under an active hold do not mature.

## Requesting a payout

Payouts are seller-initiated. You request a payout of your available balance to the bank account connected during payout setup; the current bounds are {{policy:settlement.payout.minimum}} minimum and {{policy:settlement.payout.maximum}} maximum per request. A payout moves through requested, in transit, and completed; if the provider fails the payout, the amount returns to your wallet.

A payout request is refused while payout setup is incomplete, while support holds cover the requested funds, while your balance is negative, or when the amount exceeds what is available. For 24 hours after you change your payout destination, requesting a payout requires additional identity verification.

## Shipping allowance and Order Protection

Every sale carries a seller-funded fulfillment allowance. The allowance funds the order's Order Protection contribution first and shipping second, and your order payout detail itemizes both. See [Marketplace sales and checkout fees](/sales-fees) for the published rates.

## If your balance goes negative

Refunds, chargebacks, and payout recoveries can push a wallet below zero. New sale proceeds then offset the negative balance first, before any remainder enters the normal clearance pipeline. Payout requests stay paused until the balance recovers, and prolonged negative balances move the account to collections, which also pauses new listings.
