---
slug: shipping-requirements
title: Shipping requirements
description: What sellers must know about labels, tracking, evidence tiers, signature and insurance thresholds, and address handling.
audience: seller
category: selling
reviewedAt: "2026-07-12"
citedPolicies: []
relatedFlows: ["shipping-label-or-tracking"]
claimCategories: ["shipping", "protection"]
promiseTable:
  - claim: Every shipment's evidence tier, service class, and thresholds come from the package plan committed at order time.
    issues: ["#4249"]
    tests: ["contracts/product-measures/index.test.ts", "bounded-contexts/fulfillment/features/shipments/api/runtime.test.ts"]
  - claim: Postage is purchased in-product with tracking attached before dispatch, and delivery is recorded from carrier tracking events.
    issues: ["#3558"]
    tests: ["bounded-contexts/fulfillment/features/shipments/domain/domain.test.ts", "bounded-contexts/fulfillment/features/shipments/api/runtime.test.ts"]
  - claim: Dispute evidence is submitted only when tracking proof exists; otherwise the platform records that evidence was unavailable.
    issues: ["#4245"]
    tests: ["bounded-contexts/payments/features/payments/integrations/dispute-evidence/dispute-evidence-submission.test.ts"]
  - claim: Buyer addresses are verified at checkout, snapshotted onto the shipment, and excluded from durable postage records; label address overrides require a reason and are audited.
    issues: ["#3558", "#3910"]
    tests: ["infrastructure/easypost-postage/index.test.ts", "bounded-contexts/fulfillment/features/shipments/api/runtime.test.ts"]
---
## Labels and tracking

All postage is purchased on Chase Sets. When an order is ready to ship, you buy the USPS label in-product; the tracking number attaches to the shipment automatically and delivery is recorded from carrier tracking events. There is no separate step to paste in a tracking number, and shipments cannot be dispatched without a purchased label.

Tracking is what protects you. Delivery confirmation from the carrier is what releases your sale proceeds, and tracking proof is the evidence the platform submits if a payment dispute arises. Without it, the platform records that delivery evidence was unavailable rather than inventing proof.

## Shipping evidence tiers

Each order commits to one of four evidence tiers when it is placed, based on the item value and the buyer's shipping choice:

- Untracked letter mail: raw cards only, order item value up to $50, small and light mailpieces.
- Tracked parcel: the standard tier for everything above the letter class.
- Signature-confirmed: required at $250 or more of item value, and for any priority shipment.
- Carrier-insured: required at $500 or more of item value; the shipment is insured for the item subtotal.

Slabs, sealed products, and other rigid or oversized items always ship as parcels regardless of value. The committed tier is enforced at label purchase: a shipment that requires a parcel cannot buy a letter-mail label, and required signature or insurance options are added to the label automatically.

These dollar thresholds are the current launch policy values. Orders keep the requirements committed at order time even if the policy is revised later.

## Addresses and privacy

Buyers enter their address at checkout, where it is verified against carrier delivery data. The destination is snapshotted onto the shipment, and you purchase the label without handling raw address data outside the platform: addresses are sent to the postage provider at purchase time but are not kept in durable postage records. Correcting an address at label time requires a stated reason and records a full audit trail.

Packing slips print without prices or payment details.

## What happens after dispatch

Carrier tracking events move the shipment through dispatched and delivered states, and delivery is what starts your payout clearance window — see [Getting paid](/help/selling/getting-paid). Return-to-sender and carrier exceptions are recorded against the shipment and give support a concrete record to review.
