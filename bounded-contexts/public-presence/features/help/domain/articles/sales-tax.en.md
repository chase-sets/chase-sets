---
slug: sales-tax
title: "Sales tax for sellers"
description: How U.S. marketplace facilitator laws work, how Chase Sets tracks state-by-state activity and fails closed on collection, and which sales-tax responsibilities stay yours.
audience: seller
category: selling
reviewedAt: "2026-08-02"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: State-by-state marketplace activity is evaluated against per-state registration thresholds into readiness statuses, no-statewide-sales-tax states are kept out of provider requirements, and complex local-administration states are held for manual review.
    issues: ["#5693"]
    tests: ["bounded-contexts/ordering/tests/tax-nexus-tracking.test.ts"]
  - claim: In production, when a state requires live tax collection and no provider-backed tax-quote resolver is composed, the quote request is rejected before an order can record an implicit zero-tax snapshot.
    issues: ["#5693"]
    tests: ["deployables/platform-api/__tests__/tax-readiness.test.ts"]
  - claim: Every order records an immutable tax snapshot, and the order total must reconcile the item subtotal, shipping, sales tax, and any authenticity-check fee.
    issues: ["#5693"]
    tests: ["bounded-contexts/ordering/features/orders/domain/domain.test.ts"]
---

## Two separate questions

Sales tax on a marketplace involves two different questions that are easy to blur together: what the marketplace is responsible for under state law, and what remains your responsibility as a seller. This article explains both sides for U.S. sales, as reviewed on August 2, 2026. It is general information, not tax or legal advice — whether any rule applies to your situation depends on facts a help article cannot know.

## What marketplace facilitator laws do

Since the states began taxing remote commerce broadly, many have adopted marketplace facilitator laws. Under these laws, a business that operates a marketplace and facilitates third-party sales is required to collect and remit sales tax on the sales it facilitates once its activity in the state exceeds that state's thresholds, per the [Streamlined Sales Tax Governing Board's marketplace facilitator guidance](https://www.streamlinedsalestax.org/for-businesses/marketplace-facilitator) (accessed August 2, 2026). Thresholds vary by state: a common benchmark is $100,000 in sales or 200 transactions, with some states setting higher or lower marks.

The same guidance is explicit that facilitator collection does not always end a seller's own duties: a marketplace seller may still be required to register and file returns in a state, particularly for sales made outside a marketplace.

## How Chase Sets handles sales tax today

Chase Sets tracks its marketplace activity in every U.S. state and the District of Columbia against per-state registration thresholds. Each state carries a readiness status that moves from monitoring through approaching-threshold and prepare-registration to registration-required and collection-required as activity grows. States with no statewide sales tax are kept out of collection requirements, and a small set of states with complex local tax administration is always held for manual review rather than automated threshold logic.

The system is built to fail closed. In production, if a state requires live collection and no provider-backed tax-quote service is composed, the checkout quote request is rejected — an order is never created with a silently missing tax amount. Every order that is created records an immutable tax snapshot, and the order total must reconcile the item subtotal, shipping, sales tax, and any authenticity-check fee exactly.

This article deliberately does not state whether tax is being collected on your sales in any specific state. That posture is decided per jurisdiction through a gated launch-readiness process that requires review by accounting and counsel, and it can change as marketplace activity crosses state thresholds. Chase Sets does not currently send sellers a notification when a state's collection posture changes.

## What stays your responsibility

- **Your own registrations and filings.** If you sell outside Chase Sets, or a state's rules require registration from you even where a facilitator collects, those obligations are yours.
- **Your income tax.** Sales tax and income tax are separate; marketplace proceeds are still your business income. See [Tax reporting and Form 1099-K](/help/selling/tax-reporting-1099k).
- **Your records.** Keep your own record of what you sold and where it shipped. Your payout history in [Getting paid](/help/selling/getting-paid) shows the marketplace side.
- **Your facts.** Whether any state's rules reach your activity depends on your volumes, locations, and product mix. For real decisions, work with a tax professional.
