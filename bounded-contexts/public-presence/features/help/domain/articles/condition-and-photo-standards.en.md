---
slug: condition-and-photo-standards
title: "Condition and photo standards for sellers"
description: Choose the right condition, meet the photo-evidence requirement for top grades and graded cards, enter graded-card certification details, and understand the added trust requirement for high-value listings.
audience: seller
category: selling
reviewedAt: "2026-07-13"
citedPolicies: ["marketplace.listing-evidence"]
relatedFlows: ["listing-confirmation"]
claimCategories: []
promiseTable:
  - claim: A listing at the top raw conditions requires a condition photo, and a graded listing requires front, back, and slab photos, before it can go live.
    issues: ["#4358"]
    tests:
      [
        "bounded-contexts/marketplace/features/listing-evidence-policy/domain/policy.test.ts",
        "bounded-contexts/marketplace/features/listings/domain/evidence-coverage.test.ts",
      ]
  - claim: A listing cannot be published until its evidence requirements and any seller-trust requirement are met, and the composer resolves those requirements from the active listing-evidence policy.
    issues: ["#4358"]
    tests:
      [
        "bounded-contexts/marketplace/features/listings/domain/listing-evidence-readiness.test.ts",
        "bounded-contexts/marketplace/features/listing-evidence-policy/domain/policy.test.ts",
      ]
  - claim: A graded listing records the grading company, grade, and certification number, and the certification number is validated against the grading company's format.
    issues: ["#4358"]
    tests: ["bounded-contexts/marketplace/features/listings/domain/domain.test.ts"]
---

## Pick a condition first

Every listing carries one condition. Raw, ungraded cards use a single scale, from best to worst: **Pristine**, **Mint**, **Near Mint**, **Excellent**, **Good**, **Poor**, and **Damaged**. Choose the grade a careful buyer would agree with after inspecting the card in hand, not the grade you hope for.

- **Pristine** — flawless to the naked eye and under tilted light, with no centering issues.
- **Mint** — appears flawless under normal viewing; only the faintest imperfection is detectable under deliberate angled light.
- **Near Mint** — clean and well preserved at a glance, with minor imperfections visible only on close inspection.
- **Excellent** — presents well overall with noticeable but modest wear.
- **Good** — clearly worn but still collectible and fully identifiable.
- **Poor** — significant wear across much of the card, still structurally intact.
- **Damaged** — structural damage, but still identifiable and authentic.

If your card is professionally graded, list it as a graded card instead of a raw condition. See [Graded cards](#graded-cards).

## Photo evidence for top conditions

The top raw conditions carry a photo requirement because they are the hardest for a buyer to verify from a title alone. A listing at **Mint** or **Pristine** needs a clear condition photo of the actual card before it can go live. The [listing composer](/account/listings/new) shows the requirement inline and will not let you publish until it is satisfied.

Shoot the real card you are selling, in focus, filling the frame, under even light. A stock or catalog image does not satisfy the requirement and is not a fair representation of the item.

Conditions below Mint do not carry a mandatory photo, but adding one still helps a buyer commit and reduces the chance of a not-as-described dispute later. An accurate condition and a clear photo are your best defense if a buyer questions the item.

## Graded cards

A graded card is authenticated and scored by a professional grading company, sealed in a tamper-evident slab. When you list one, record its certification details so buyers can verify it:

- **Grading company** — the service that graded the card. Supported companies with validated certificate formats are **PSA**, **BGS** (Beckett), **CGC**, and **SGC**.
- **Grade** — the numeric grade on the label, from `1` to `10` in half-point steps (for example `9`, `9.5`, `10`).
- **Certification number** — the number printed on the slab label. Each company uses its own length, so enter the exact digits from the label; the composer checks the number against that company's format.

A graded listing requires three photos — the **slab**, the card **front**, and the card **back** — so a buyer can read the label and inspect both faces. As with raw conditions, you cannot publish a graded listing until all three views are attached.

## Higher-value listings

Listings above a price threshold carry an added seller-trust requirement: your account needs enough completed-sale reviews, or a qualifying seller badge, before the listing can go live. This keeps the highest-value listings anchored to a track record and is separate from the photo requirement — a high-value listing must meet both.

The exact price threshold and trust requirement come from the active listing-evidence policy, and the [listing composer](/account/listings/new) shows the specific requirement that applies to your item before you publish. You build the review history that satisfies this requirement by fulfilling smaller orders well before you list your highest-value cards.

## Where you set all of this

Condition, graded-card details, and photos are all part of the [listing composer](/account/listings/new). The composer resolves the current requirements for your specific item and price and blocks publication until every requirement is met, so nothing goes live understated. Requirements are policy-driven and can change; the composer always reflects the version in effect when you publish.
