---
slug: sales-fees
path: /sales-fees
title: Marketplace sales and checkout fees
description: See the live standard sales-fee schedule, listing-time fee locks, the founders window, and buyer checkout processing fees.
audience: seller
category: selling
reviewedAt: "2026-07-14"
citedPolicies: ["commercial-terms.marketplace-sales-fee-schedule", "commercial-terms.checkout-processing-fee"]
relatedFlows: ["listing-confirmation", "checkout-price-breakdown"]
claimCategories: ["fees"]
promiseTable:
  - claim: Published fee figures resolve from the current ratified policy documents.
    issues: ["#4353"]
    tests: ["bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx"]
  - claim: Confirming a listing locks the resolved fee terms for its units, and later schedule revisions never change locked units.
    issues: ["#4067"]
    tests: ["bounded-contexts/marketplace/features/listings/domain/domain.test.ts", "bounded-contexts/commercial-terms/features/resolutions/read-model/resolve.test.ts"]
  - claim: The per-item fee cap is re-audited when settlement credits the seller.
    issues: ["#4099"]
    tests: ["bounded-contexts/settlement/features/wallets/integrations/payment-source/payment-source-projection.test.ts"]
  - claim: The founders window applies a 0% sales-fee agreement for 60 days, capped at 500 founders.
    issues: ["#4068"]
    tests: ["bounded-contexts/identity/features/founders-cohort/domain/domain.test.ts", "bounded-contexts/commercial-terms/features/agreements/integrations/identity/founders-window-reaction.test.ts"]
  - claim: Beta access uses three numbered invite waves with ratified capacities and explicit wave-one qualification.
    issues: ["#3955"]
    tests: ["bounded-contexts/commercial-terms/routes/public/sales-fees.test.tsx", "bounded-contexts/public-presence/features/waitlist/ui/public-pages.test.tsx"]
---
## One standard sales fee

Personal, business, and enterprise accounts all use the same standard schedule: {{policy:marketplace-sales-fee.standard.bps}} of the item price plus {{policy:marketplace-sales-fee.standard.fixed}}, capped at {{policy:marketplace-sales-fee.standard.cap}} per item.

There is no separate listing fee. You see the applicable sales fee before confirming a listing, and the locked amount does not change for that transaction if the published schedule is revised later.

## How fee locks work

Confirming a listing locks the fee terms you saw — the rate, the fixed amount, and the per-item cap — for every unit created at that moment. If the published schedule changes between your fee preview and your confirmation, the confirmation is rejected and you re-confirm at the current terms; nothing is locked silently.

The lock covers the formula, not a frozen dollar figure: if you edit the item price later, the fee is recomputed from your locked terms, never from a newer schedule. Units you add when restocking lock at the schedule in effect at that time, so one listing can carry tranches at different locked terms. The same locked formula is re-applied when the order is placed, and settlement re-audits the fee — including the per-item cap — before crediting your sale proceeds.

## Founders window

The first 500 accounts to list an item or submit an offer after receiving beta access claim a founders place. A founders account pays a 0% marketplace sales fee for 60 days from the start of its beta access; listings confirmed inside the window lock the 0% rate exactly like any other locked rate. After the window ends, new listings lock at the standard schedule.

Founders also join the founders-circle Discord and help shape seller tools such as bulk listing, pricing, fulfillment, fee locks, and offers. The badge appears publicly on the account and its listings and stays permanently.

## Beta invite waves

Before signup opens to everyone on September 1, 2026, beta access is admitted in three numbered waves:

- Wave 1: 100 invites
- Wave 2: 250 invites
- Wave 3: 500 invites

A qualified seller signup chooses Sell or Buy and sell, names at least one supported game, and selects an inventory-size range. Wave 1 requires at least 500 total signups, 50 qualified sellers, and at least five qualified sellers for each of the five supported games. It prioritizes those qualified sellers and then the highest-intent buyers.

Wave 2 prioritizes qualified sellers with a live TCGplayer or eBay store link and referral-queue leaders. Wave 3 continues from the referral queue. Later waves open only while checkout failures stay below 2%, projections remain near real time, and support load stays within a solo operator's capacity.

An invite starts the 60-day founders window, but it does not claim a founder number. The first listing or offer claims the next number while one of the 500 remains.

## Checkout processing fees

Buyers see the applicable checkout fee before payment. The current processing rates are:

- Card: {{policy:checkout-processing-fee.card.bps}} plus {{policy:checkout-processing-fee.card.fixed}}
- Bank account: {{policy:checkout-processing-fee.bank-account.bps}} plus {{policy:checkout-processing-fee.bank-account.fixed}}
- Chase Sets credit: {{policy:checkout-processing-fee.platform-credit.bps}} plus {{policy:checkout-processing-fee.platform-credit.fixed}}

## Order Protection and shipping

Every order includes Order Protection. Each order contributes 1% of the item subtotal to the protection reserve, rounded up to the nearest cent. The seller-funded shipping allowance funds Order Protection first and shipping second; any remaining combined overflow appears to the buyer only as one Shipping amount. There is never a separate buyer-facing protection fee.

Founders' 0% Marketplace Sales Fee applies only to the sales fee. It does not reduce or remove the 1% Order Protection contribution.

For how the allowance and protection interact with your payout, see [Getting paid](/help/selling/getting-paid). For how protection works for buyers, see [Order protection](/help/buying/order-protection).

## When policy values change

This page reads the effective policy values when it renders and refreshes within six minutes. If a scheduled revision is within 30 days, the page shows its effective date before the change takes effect.
