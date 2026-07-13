---
slug: creators-and-press
path: /press
title: Creator and press fact sheet
description: "One page for creators and press: what Chase Sets is, the launch timeline, the founders offer, live marketplace fees, and Order Protection."
audience: buyer
category: getting-started
reviewedAt: "2026-07-12"
citedPolicies: ["commercial-terms.marketplace-sales-fee-schedule", "commercial-terms.checkout-processing-fee"]
relatedFlows: []
claimCategories: ["fees", "protection"]
promiseTable:
  - claim: Published fee figures resolve from the current ratified policy documents.
    issues: ["#4353"]
    tests: ["bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx"]
  - claim: Public launch is September 1, 2026, with beta invite waves beginning late July 2026.
    issues: ["#3952"]
    tests: ["bounded-contexts/public-presence/features/waitlist/ui/public-pages.test.tsx"]
  - claim: Every order includes a 1% Order Protection reserve contribution without a separate buyer fee line.
    issues: ["#4098"]
    tests: ["bounded-contexts/ordering/features/orders/domain/policies.test.ts", "bounded-contexts/settlement/features/wallets/integrations/payment-source/payment-source-projection.test.ts"]
---
## What Chase Sets is

Chase Sets is a trading card marketplace built for accounts that both buy and sell. At launch it supports five games — Pokemon (English and Japanese), Magic: The Gathering, Yu-Gi-Oh!, Disney Lorcana, and One Piece Card Game — each with a full curated catalog covering raw and graded singles.

Marketplace checkout is not open yet. During prelaunch the public site takes early-access signups, and buyers can already see how pricing works: delivered totals are shown before payment, with no hidden buyer fees at checkout.

## Launch timeline

- Beta invite waves begin late July 2026.
- Public launch — open signup for everyone — is September 1, 2026.

Invite waves are gated on operational readiness between waves, so Chase Sets does not promise per-wave dates.

## The founders offer

The first 500 accounts to list or make an offer claim a numbered founder badge, shown publicly and kept permanently. Beta access also opens a 60-day 0% seller-fee window: every listing created in that window locks 0% seller fees until it sells. The complete plain-language terms, including exactly how the fee lock behaves, are published at [Founders offer terms](/founders).

## Marketplace fees

Fee figures on this page are read live from the published policy documents, not copied into the text:

- Standard sales fee for every account type: {{policy:marketplace-sales-fee.standard.bps}} of the item price plus {{policy:marketplace-sales-fee.standard.fixed}}, capped at {{policy:marketplace-sales-fee.standard.cap}} per item.
- There is no separate listing fee.
- Buyer checkout processing: {{policy:checkout-processing-fee.card.bps}} plus {{policy:checkout-processing-fee.card.fixed}} by card, {{policy:checkout-processing-fee.bank-account.bps}} plus {{policy:checkout-processing-fee.bank-account.fixed}} by bank account, and {{policy:checkout-processing-fee.platform-credit.bps}} plus {{policy:checkout-processing-fee.platform-credit.fixed}} with Chase Sets credit.

The full schedule and how listing-time fee locks work are on the [marketplace sales fee schedule](/sales-fees).

## Order Protection

Every order includes Order Protection — funded at 1% of item value and never itemized as a separate buyer fee. How safeguards apply across payment, fulfillment, disputes, and payouts is documented in [Order protection](/help/buying/order-protection).

## Graded cards

Beta supports graded-card listings — PSA, BGS, CGC, and SGC certification numbers, validated, with slab photos required.

## Open offers

Buyers can post open offers — the price they will pay for a card — so sellers can sell into demand instead of waiting for a search.

## About the founder

Chase Sets is founder-built: the founder buys, sells, and ships trading cards himself, and the fee math and policies stay public instead of buried in fine print. Founder interviews and quotes are available on request.

## Creator and press contact

Email [support@chasesets.com](mailto:support@chasesets.com) for creator partnerships, press questions, screenshots, logo files, and interview requests, or use the [contact page](/contact). Chase Sets does not publish user or sales counts during prelaunch, so please do not cite traction numbers from third parties.
