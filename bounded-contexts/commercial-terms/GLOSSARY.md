# Commercial Terms Domain Glossary

This glossary defines the canonical terminology for the Commercial Terms bounded context.

## Commercial Terms Schedule

A **Commercial Terms Schedule** is a dormant account-type-targeted fee policy retained for possible future differentiation. It is not a published launch schedule.

## Marketplace Sales Fee Schedule

The **Marketplace Sales Fee Schedule** is the single published seller-side fee policy over an effective time window. It defines the percentage, fixed amount, per-item cap, and Shipping Allowance used when no Commercial Agreement overrides it.

## Marketplace Sales Fee Cap

A **Marketplace Sales Fee Cap** is the maximum Marketplace Sales Fee charged for one item under a Marketplace Sales Fee Schedule.

## Commercial Agreement

A **Commercial Agreement** is an account-specific override to the default commercial terms.

## Founders Window Agreement

A **Founders Window Agreement** is the active Commercial Agreement automatically created from an Identity-owned Founders Window admission. It applies 0% Marketplace Sales Fees from beta access start until the exclusive 60-day endpoint; after that endpoint, new Listings resolve against the published Marketplace Sales Fee Schedule while already locked Listings retain their 0% snapshot.

## Commercial Terms Resolution

A **Commercial Terms Resolution** is the deterministic result of selecting the applicable schedule and agreement for an account at a point in time.

## Marketplace Sales Fee

A **Marketplace Sales Fee** is the seller-side fee charged by the marketplace for listing and transaction participation.

## Shipping Allowance

A **Shipping Allowance** is the Commercial Terms-owned percentage used to calculate how much of a shipping charge is credited back to the selling account as part of seller payout economics.

Notes:

- Commercial Terms owns the configurable Shipping Allowance percentage on default schedules and account-specific agreements.
- Marketplace, Ordering, Payments, and Settlement consume immutable snapshots of the resolved Shipping Allowance; they do not recalculate historical commitments when Commercial Terms are revised.
- Settlement posts the resulting shipping allowance credit as a Rebate ledger entry.
- Ordering applies the resolved allowance to Order Protection first and shipping second; Commercial Terms owns the percentage, not the allocation calculation.

## Seller Net

A **Seller Net** is the amount remaining from the resolved basis amount after the marketplace sales fee amount is applied.

## Checkout Processing-Fee Policy

A **Checkout Processing-Fee Policy** is the runtime-configurable, admin-managed policy for the buyer-side Marketplace Checkout Fee: base percentage/fixed terms, per-payment-method-category adjustments, and enabled jurisdictions. It is account-type-agnostic and effective-windowed, declared on the shared `@chase-sets/platform-policy` machinery rather than the Commercial Terms Schedule/Agreement pattern. Payments resolves the current value at quote time and owns the quote math itself; Commercial Terms owns only the policy value.

## Authenticity Fee Policy

An **Authenticity Fee Policy** is the runtime-configurable, admin-managed policy for the buyer-opt-in Authenticity Check fee (m109): an opt-in order-value threshold plus banded flat + percentage-of-order-value terms, capped per band, with an optional per-category (raw/graded) override. It follows the Checkout Processing-Fee Policy pattern exactly, declared on the shared `@chase-sets/platform-policy` machinery. Ordering resolves the current value at checkout-preview and order-creation time and owns the quote math itself; Commercial Terms owns only the policy value.
