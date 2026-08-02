---
slug: community-guidelines-and-enforcement
title: "Community guidelines and enforcement"
description: The conduct rules for buying, reviewing, and reporting on Chase Sets, why transactions stay on the platform, and how recorded, human moderation and account enforcement work.
audience: buyer
category: buying
reviewedAt: "2026-08-02"
citedPolicies: []
relatedFlows: []
claimCategories: []
promiseTable:
  - claim: Accounts cannot offer on their own listings, cannot add their own listings to cart, and same-account order creation is rejected.
    issues: ["#5693"]
    tests:
      [
        "bounded-contexts/marketplace/features/offers/api/runtime.test.ts",
        "bounded-contexts/checkout/features/cart/domain/domain.test.ts",
        "bounded-contexts/ordering/features/orders/domain/domain.test.ts",
      ]
  - claim: A review is tied to one completed order between its two parties, self-review is rejected, and operator withdrawal or redaction of a review requires a recorded reason.
    issues: ["#5693"]
    tests: ["bounded-contexts/marketplace/features/reviews/domain/domain.test.ts"]
  - claim: A reported active listing auto-unlists only at the distinct-reporter threshold, review reports join the same moderation queue without automatic removal, and duplicate reports from the same reporter are rejected.
    issues: ["#5693"]
    tests: ["bounded-contexts/marketplace/features/reports/api/runtime.test.ts"]
  - claim: Every moderation action on reported content is recorded with the action taken, the acting operator, and any required note.
    issues: ["#5693"]
    tests: ["bounded-contexts/platform-operations/features/reported-content/read-model/projection.test.ts"]
---

## The short version

Deal honestly, keep your transactions on Chase Sets, and treat the people on the other side of a trade the way you would want to be treated. The rest of this article spells out what that means for buying, reviewing, and reporting, and what happens when someone breaks the rules.

## Buy and sell in good faith

- **Complete your purchases.** An order is a real commitment to the seller on the other side.
- **Keep transactions on Chase Sets.** Do not use the marketplace to find a buyer or seller and then move the deal off the platform to avoid fees. A deal completed off Chase Sets is outside [Order protection](/help/buying/order-protection), the support process, and everything else the platform provides, and arranging one is a policy violation for both sides.
- **No self-dealing.** Buying from yourself is blocked outright: you cannot make an offer on your own listing, add your own listing to your cart, or create an order with yourself on both sides.
- **Do not manipulate prices or listings.** Pricing scams are a reportable offense on any listing.

## Reviews

Reviews on Chase Sets are transactional: a review is always attached to one completed order, only the two parties to that order can review each other, and each direction gets at most one active review. You cannot review yourself, and review windows close, so leave feedback while it is fresh.

Write about the transaction — the item, the communication, the outcome. A review must not contain:

- harassment or abuse
- hateful or discriminatory content
- someone's personal information
- spam or manipulation, including feedback traded, bought, or coordinated to game a rating

The reviewed account can post one public response to a revealed review. Responses follow the same conduct rules.

## Reporting content

If you see a listing or review that breaks the rules, report it from the page it appears on. Listing reports accept a structured reason — counterfeit concern, stolen photos, prohibited item, pricing scam, or other — and anyone can submit one, signed in or not. Review reports require a signed-in account and use their own reasons: harassment or abuse, hate or discrimination, personal information, spam or manipulation, or other. Each person can report a given piece of content once, and you can add a short explanation to help the review.

## How enforcement works

Reports feed a Trust & Safety queue where a person reviews each case and decides the outcome. Depending on what the review finds, the reviewer may dismiss the report, contact the seller, unlist a listing, withdraw a review or redact its written feedback, or escalate the account for suspension. Every action is recorded with who took it and why, and review-scoped actions always carry a written reason.

Two automatic behaviors exist, and only two: an active listing is unlisted automatically when enough distinct people report it, and duplicate reports from the same person are rejected. A reported review is never removed automatically — a person decides.

At the account level, an account can be suspended and later reactivated once the underlying issue is resolved, or closed, which is final. Serious or repeated violations are what put an account on that path.

## If you think we got it wrong

Enforcement decisions are made by people, and people can be wrong. If a report you filed was dismissed, or an action was taken against your content or account and you believe it was a mistake, contact [support](/contact) or email [support@chasesets.com](mailto:support@chasesets.com) and ask for the decision to be reconsidered. There is no separate in-product appeal form today; reconsideration goes through support, and a person reviews it.
