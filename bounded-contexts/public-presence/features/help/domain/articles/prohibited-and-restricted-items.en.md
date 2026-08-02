---
slug: prohibited-and-restricted-items
title: "Prohibited and restricted items"
description: What you can list on Chase Sets, why every listing starts from the catalog, which items and photos are never allowed, and how reports and removal work.
audience: seller
category: selling
reviewedAt: "2026-08-02"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: Every listing is created from an inventory item that references one Chase Sets catalog entry, and there is no free-text listing path.
    issues: ["#5693"]
    tests:
      [
        "bounded-contexts/inventory/tests/account-inventory-routes.test.ts",
        "bounded-contexts/marketplace/features/listings/api/runtime.test.ts",
      ]
  - claim: A listing cannot be published until the photo-evidence and seller-trust requirements resolved from the active listing-evidence policy are met.
    issues: ["#4358"]
    tests:
      [
        "bounded-contexts/marketplace/features/listings/domain/listing-evidence-readiness.test.ts",
        "bounded-contexts/marketplace/features/listing-evidence-policy/domain/policy.test.ts",
      ]
  - claim: A reported active listing is automatically unlisted only when the distinct-reporter threshold is reached, and every moderation action on a report is recorded.
    issues: ["#5693"]
    tests:
      [
        "bounded-contexts/marketplace/features/reports/api/runtime.test.ts",
        "bounded-contexts/platform-operations/features/reported-content/read-model/projection.test.ts",
      ]
---

## Every listing starts from the catalog

Chase Sets is a trading-card marketplace built on a closed catalog. You create a listing by picking the exact catalog entry for the product you are selling, recording it as an inventory item, and listing that item. There is no free-text listing form, so an item the catalog does not describe cannot be listed at all.

That design does most of the "prohibited items" work for you: the question is never whether a category of goods is allowed, but whether your specific item genuinely is the catalog product you selected. You are responsible for choosing the catalog entry that correctly matches the item in your hand.

## Items you must not list

- **Counterfeit or fake cards.** A counterfeit is not the catalog product it imitates. Listing one against a genuine card's catalog entry misrepresents the item, and buyers and visitors can flag it with a counterfeit-concern report.
- **Proxies, customs, and reproductions presented as genuine.** The same rule applies: a proxy or reproduction is not the genuine catalog product, so listing it as one is treated the same way as any other counterfeit concern.
- **Items you do not have the right to sell.** Only list items you own, or are authorized by the owner to sell, and that you actually have. Do not list items you hope to acquire only after a sale.
- **Items that infringe someone's intellectual property.** See [Intellectual property and DMCA](/help/selling/intellectual-property-and-dmca) for how infringement claims are handled.

## Photos must be yours

Your listing photos must show the actual item you are selling. Photos copied from another seller's listing or lifted from elsewhere can be flagged with a stolen-photos report, and stock or catalog images never satisfy a photo-evidence requirement. The photo rules, including which conditions require photos, are covered in [Condition and photo standards](/help/selling/condition-and-photo-standards).

## Restricted rather than prohibited

Some listings are allowed but carry extra requirements before they can go live:

- A listing at the top raw conditions needs a condition photo of the actual card.
- A graded listing needs slab, front, and back photos plus the grading company, grade, and certification number.
- Listings above a price threshold carry an added seller-trust requirement, so your account needs a track record or a qualifying badge first.

These requirements come from the active listing-evidence policy, and the listing composer blocks publication until every requirement is satisfied. [Condition and photo standards](/help/selling/condition-and-photo-standards) explains each one.

## How reports and removal work

Anyone who sees a problem listing, signed in or not, can report it with a structured reason: counterfeit concern, stolen photos, prohibited item, pricing scam, or other. Each person can report a given listing once, and an optional explanation helps the review.

Reports go to Trust & Safety review, where a person looks at the listing and decides what to do; each recorded action captures who took it and why. If enough distinct reporters flag the same active listing, it is unlisted automatically while review happens. Serious or repeated problems can escalate to account-level enforcement, described in [Community guidelines and enforcement](/help/buying/community-guidelines-and-enforcement).

If your listing was removed and you believe that was a mistake, contact [support](/contact) and ask for the decision to be looked at again.
