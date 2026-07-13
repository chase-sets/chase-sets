---
slug: refunds-and-returns
title: Refunds and returns
description: How refund and return handling relates to order status, payment outcome, shipment progress, and support review.
audience: buyer
category: buying
reviewedAt: "2026-07-12"
citedPolicies: []
relatedFlows: []
claimCategories: ["protection", "shipping"]
promiseTable:
  - claim: Refund and return outcomes are tied to durable payment and shipment behavior.
    issues: ["#4352"]
    tests: ["bounded-contexts/payments/features/refunds/api/runtime.test.ts", "bounded-contexts/fulfillment/features/shipments/domain/domain.test.ts"]
---
## Current availability

Marketplace checkout opens at launch. Until then, the public site does not create purchases, charges, refunds, or returns.

## Marketplace model

Return options, dispute paths, payment outcomes, and support contact stay visible before and after checkout so accounts understand the path before money moves.

## Support

For questions about refund or return handling, contact support@chasesets.com.
