# Commercial Terms Domain Glossary

This glossary defines the canonical terminology for the Commercial Terms bounded context.

## Commercial Terms Schedule

A **Commercial Terms Schedule** is the default fee policy for one account type over an effective time window.

## Commercial Agreement

A **Commercial Agreement** is an account-specific override to the default commercial terms.

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

## Seller Net

A **Seller Net** is the amount remaining from the resolved basis amount after the marketplace sales fee amount is applied.

## Checkout Processing-Fee Policy

A **Checkout Processing-Fee Policy** is the runtime-configurable, admin-managed policy for the buyer-side Marketplace Checkout Fee: base percentage/fixed terms, per-payment-method-category adjustments, and enabled jurisdictions. It is account-type-agnostic and effective-windowed, declared on the shared `@chase-sets/platform-policy` machinery rather than the Commercial Terms Schedule/Agreement pattern. Payments resolves the current value at quote time and owns the quote math itself; Commercial Terms owns only the policy value.
